import { Types } from 'mongoose';
import { ReflectionMemoryModel, } from '../domain/Models/ReflectionMemory.js';
import { generateEmbedding, cosineSimilarity } from '../infrastructure/Embeddings/embeddingService.js';
import { toObjectIdString } from '../domain/Types/mirror.js';
const summarizeInline = (text, maxLength = 100) => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return 'No reflection submitted.';
    }
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
};
/* ------------------------------------------------------------------ */
/*  Store reflections with embeddings                                   */
/* ------------------------------------------------------------------ */
export class MemoryApplication {
    /**
     * Store a partner's reflection with its vector embedding.
     * Called when a partner submits homework.
     */
    static async storeReflection(args) {
        try {
            const embeddingText = `${args.assignmentTitle}: ${args.reflectionText}`;
            const embedding = await generateEmbedding(embeddingText);
            // Count existing reflections to determine session number
            const existingCount = await ReflectionMemoryModel.countDocuments({
                coupleId: new Types.ObjectId(args.coupleId),
                memoryType: 'reflection',
                userId: { $ne: 'system' },
            });
            const sessionNumber = Math.floor(existingCount / 2) + 1;
            // Upsert: replace existing reflection for same user + session + assignment
            await ReflectionMemoryModel.findOneAndUpdate({
                coupleId: new Types.ObjectId(args.coupleId),
                sessionId: new Types.ObjectId(args.sessionId),
                memoryType: 'reflection',
                userId: args.userId,
                assignmentTitle: args.assignmentTitle,
            }, {
                $set: {
                    memoryType: 'reflection',
                    partnerRole: args.partnerRole,
                    partnerName: args.partnerName,
                    reflectionPrompt: args.reflectionPrompt,
                    reflectionText: args.reflectionText,
                    sessionSummary: args.sessionSummary || '',
                    embedding: embedding.vector,
                    embeddingProvider: embedding.provider,
                    embeddingFallback: embedding.fallbackUsed,
                    sessionNumber,
                },
                $setOnInsert: {
                    coupleId: new Types.ObjectId(args.coupleId),
                    sessionId: new Types.ObjectId(args.sessionId),
                    memoryType: 'reflection',
                    userId: args.userId,
                    assignmentTitle: args.assignmentTitle,
                },
            }, { upsert: true });
        }
        catch (error) {
            console.warn('[memory] Failed to store reflection embedding:', error);
        }
    }
    /**
     * Store a session summary as a searchable memory entry.
     * Called when a session completes with a truth report.
     */
    static async storeSessionSummary(args) {
        try {
            const summaryText = [
                `Session Summary: ${args.truthSummary}`,
                `Core conflict: ${args.coreConflict}`,
                `Observed patterns: ${args.observedPatterns.join(', ')}`,
            ].join('. ');
            const embedding = await generateEmbedding(summaryText);
            await ReflectionMemoryModel.findOneAndUpdate({
                coupleId: new Types.ObjectId(args.coupleId),
                sessionId: new Types.ObjectId(args.sessionId),
                memoryType: 'session_summary',
                userId: 'system',
                assignmentTitle: 'Session Summary',
            }, {
                $set: {
                    memoryType: 'session_summary',
                    partnerRole: 'system',
                    partnerName: 'Mirror',
                    reflectionPrompt: 'session-summary',
                    reflectionText: summaryText,
                    sessionSummary: args.truthSummary,
                    embedding: embedding.vector,
                    embeddingProvider: embedding.provider,
                    embeddingFallback: embedding.fallbackUsed,
                    sessionNumber: 0,
                },
                $setOnInsert: {
                    coupleId: new Types.ObjectId(args.coupleId),
                    sessionId: new Types.ObjectId(args.sessionId),
                    memoryType: 'session_summary',
                    userId: 'system',
                    assignmentTitle: 'Session Summary',
                },
            }, { upsert: true });
        }
        catch (error) {
            console.warn('[memory] Failed to store session summary embedding:', error);
        }
    }
    static async storeConversationDigest(args) {
        try {
            const embedding = await generateEmbedding(args.digestText);
            await ReflectionMemoryModel.findOneAndUpdate({
                coupleId: new Types.ObjectId(args.coupleId),
                sessionId: new Types.ObjectId(args.sessionId),
                memoryType: 'conversation_digest',
                userId: 'system',
                assignmentTitle: 'Conversation Digest',
            }, {
                $set: {
                    memoryType: 'conversation_digest',
                    partnerRole: 'system',
                    partnerName: 'Mirror',
                    reflectionPrompt: 'conversation-digest',
                    reflectionText: args.digestText,
                    sessionSummary: args.sessionSummary || '',
                    embedding: embedding.vector,
                    embeddingProvider: embedding.provider,
                    embeddingFallback: embedding.fallbackUsed,
                    sessionNumber: 0,
                },
                $setOnInsert: {
                    coupleId: new Types.ObjectId(args.coupleId),
                    sessionId: new Types.ObjectId(args.sessionId),
                    memoryType: 'conversation_digest',
                    userId: 'system',
                    assignmentTitle: 'Conversation Digest',
                },
            }, { upsert: true });
        }
        catch (error) {
            console.warn('[memory] Failed to store conversation digest embedding:', error);
        }
    }
    /* ------------------------------------------------------------------ */
    /*  Retrieve reflections                                               */
    /* ------------------------------------------------------------------ */
    /**
     * Retrieve ALL reflections for a couple, ordered chronologically.
     * This gives the AI complete knowledge of what both partners have written.
     */
    static async getAllReflections(coupleId) {
        return ReflectionMemoryModel.find({
            coupleId: new Types.ObjectId(coupleId),
            memoryType: 'reflection',
            userId: { $ne: 'system' },
        })
            .sort({ createdAt: 1 })
            .exec();
    }
    /**
     * Retrieve all session summaries for a couple, ordered chronologically.
     */
    static async getAllSessionSummaries(coupleId) {
        return ReflectionMemoryModel.find({
            coupleId: new Types.ObjectId(coupleId),
            memoryType: 'session_summary',
            userId: 'system',
        })
            .sort({ createdAt: 1 })
            .exec();
    }
    static async getRecentConversationDigests(coupleId, limit = 4) {
        return ReflectionMemoryModel.find({
            coupleId: new Types.ObjectId(coupleId),
            memoryType: 'conversation_digest',
            userId: 'system',
        })
            .sort({ createdAt: -1 })
            .limit(limit)
            .exec();
    }
    /**
     * Semantic search: find reflections similar to a query string.
     * Attempts Atlas $vectorSearch first, falls back to manual cosine similarity.
     */
    static async searchSimilarReflections(args) {
        const queryEmbedding = await generateEmbedding(args.query);
        const limit = args.limit || 10;
        // Attempt Atlas Vector Search
        try {
            const results = await ReflectionMemoryModel.aggregate([
                {
                    $vectorSearch: {
                        index: 'reflection_vector_index',
                        path: 'embedding',
                        queryVector: queryEmbedding.vector,
                        numCandidates: limit * 10,
                        limit,
                        filter: {
                            coupleId: new Types.ObjectId(args.coupleId),
                        },
                    },
                },
                {
                    $addFields: {
                        similarity: { $meta: 'vectorSearchScore' },
                    },
                },
            ]);
            if (results.length > 0) {
                return results;
            }
        }
        catch {
            // Atlas Vector Search not available — fall through to manual approach
        }
        // Fallback: manual cosine similarity
        const allMemories = await ReflectionMemoryModel.find({
            coupleId: new Types.ObjectId(args.coupleId),
        }).exec();
        return allMemories
            .filter((mem) => mem.embedding && mem.embedding.length > 0 && mem.embedding.some((v) => v !== 0))
            .map((mem) => {
            const doc = mem.toObject();
            doc.similarity = cosineSimilarity(queryEmbedding.vector, mem.embedding);
            return doc;
        })
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, limit);
    }
    /* ------------------------------------------------------------------ */
    /*  Context builders for AI sessions                                   */
    /* ------------------------------------------------------------------ */
    /**
     * Build a comprehensive, chronological reflection context that gives the AI
     * FULL knowledge of every reflection ever written by both partners.
     */
    static async buildReflectionContext(args) {
        const allReflections = await this.getAllReflections(args.coupleId);
        if (allReflections.length === 0) {
            return '';
        }
        const partnerAName = args.couple.partnerAName;
        const partnerBName = args.couple.partnerBName || 'Partner B';
        const parts = [
            '=== COMPLETE REFLECTION HISTORY (ALL SESSIONS) ===',
            `Total reflections on record: ${allReflections.length}`,
            '',
        ];
        // Group by session
        const bySession = new Map();
        for (const ref of allReflections) {
            const key = toObjectIdString(ref.sessionId);
            if (!bySession.has(key)) {
                bySession.set(key, []);
            }
            bySession.get(key).push(ref);
        }
        let sessionIdx = 1;
        for (const [, refs] of bySession) {
            parts.push(`--- After Session ${sessionIdx} ---`);
            for (const ref of refs) {
                const name = ref.partnerRole === 'partner_a' ? partnerAName : partnerBName;
                parts.push(`${name}'s reflection on "${ref.assignmentTitle}":`);
                parts.push(`  Prompt asked: "${ref.reflectionPrompt}"`);
                parts.push(`  Their response: "${ref.reflectionText}"`);
                if (ref.sessionSummary) {
                    parts.push(`  Session context: ${ref.sessionSummary}`);
                }
                parts.push(`  Written on: ${ref.createdAt.toISOString().split('T')[0]}`);
                parts.push('');
            }
            sessionIdx++;
        }
        return parts.join('\n');
    }
    /**
     * Build the current homework gate reflections formatted for the AI to
     * discuss at the start of the next session.
     */
    static buildCurrentReflectionsForDiscussion(couple) {
        const gate = couple.activeHomeworkGate;
        if (!gate || gate.assignments.length === 0) {
            return '';
        }
        const partnerAName = couple.partnerAName;
        const partnerBName = couple.partnerBName || 'Partner B';
        const parts = [
            '=== REFLECTIONS TO DISCUSS THIS SESSION ===',
            'YOU MUST review these reflections with both partners before moving to any other topic.',
            'Read their words back to them. Ask if they meant it. Push for honesty.',
            '',
        ];
        for (const assignment of gate.assignments) {
            parts.push(`Assignment: "${assignment.title}"`);
            parts.push(`Description: ${assignment.description}`);
            parts.push(`Prompt: "${assignment.reflectionPrompt}"`);
            parts.push('');
            for (const reflection of assignment.reflections) {
                const isPartnerA = reflection.userId === couple.partnerAUserId;
                const name = isPartnerA ? partnerAName : partnerBName;
                parts.push(`  ${name} wrote (completed: ${reflection.completed}):`);
                parts.push(`  "${reflection.reflection}"`);
                parts.push('');
            }
            if (assignment.reflections.length === 0) {
                parts.push('  WARNING: No reflections submitted. Call this out immediately.');
                parts.push('');
            }
            const partnerAReflection = assignment.reflections.find((r) => r.userId === couple.partnerAUserId);
            const partnerBReflection = assignment.reflections.find((r) => r.userId === couple.partnerBUserId);
            if (!partnerAReflection) {
                parts.push(`  ${partnerAName} DID NOT submit a reflection. Confront them about this.`);
            }
            if (!partnerBReflection) {
                parts.push(`  ${partnerBName} DID NOT submit a reflection. Confront them about this.`);
            }
            parts.push('');
        }
        return parts.join('\n');
    }
    static buildReflectionOpeningLine(couple, options) {
        const gate = couple.activeHomeworkGate;
        if (!gate || gate.assignments.length === 0) {
            return '';
        }
        const describePartner = (partnerRole, partnerName, userId) => {
            if (!userId) {
                return '';
            }
            const partnerAssignments = gate.assignments.slice(0, 2).map((assignment) => {
                const reflection = assignment.reflections.find((entry) => entry.userId === userId);
                if (!reflection?.reflection.trim()) {
                    return `${assignment.title}: no reflection submitted`;
                }
                return `${assignment.title}: "${summarizeInline(reflection.reflection, 88)}"`;
            });
            if (partnerAssignments.length === 0) {
                return `${partnerName}, there is no saved homework from you yet.`;
            }
            const prefix = partnerRole === 'partner_a' ? `${partnerName}, you wrote` : `${partnerName}, you wrote`;
            return `${prefix} ${partnerAssignments.join('; ')}.`;
        };
        const partnerALine = describePartner('partner_a', couple.partnerAName, couple.partnerAUserId);
        const partnerBLine = describePartner('partner_b', couple.partnerBName || 'Partner B', couple.partnerBUserId);
        if (options?.presentPartnerRole === 'partner_a') {
            return `${partnerALine} We start there, and we wait for ${couple.partnerBName || 'your partner'} before we move on.`;
        }
        if (options?.presentPartnerRole === 'partner_b') {
            return `${partnerBLine} We start there, and we wait for ${couple.partnerAName} before we move on.`;
        }
        return [
            'We are starting with the homework, not avoiding it.',
            partnerALine,
            partnerBLine,
            'We are going to test whether those words are real in this room.',
        ]
            .filter(Boolean)
            .join(' ');
    }
    /**
     * Build the enriched opening context for a new session.
     * Combines: previous summary + ALL past reflections + session summaries +
     * current homework reflections to discuss.
     */
    static async buildEnrichedOpeningContext(args) {
        const parts = [];
        // Previous session summary
        if (args.previousSummary) {
            parts.push(`Previous session memory: ${args.previousSummary}`);
        }
        else {
            parts.push("This is the couple's first session — no prior session memory exists yet.");
        }
        // All past session summaries from vector memory
        const sessionSummaries = await this.getAllSessionSummaries(args.coupleId);
        if (sessionSummaries.length > 0) {
            parts.push('');
            parts.push('=== ALL PAST SESSION SUMMARIES ===');
            for (let i = 0; i < sessionSummaries.length; i++) {
                parts.push(`Session ${i + 1}: ${sessionSummaries[i].reflectionText}`);
            }
        }
        const conversationDigests = await this.getRecentConversationDigests(args.coupleId);
        if (conversationDigests.length > 0) {
            parts.push('');
            parts.push('=== RECENT CONVERSATION DIGESTS ===');
            for (const digest of conversationDigests.reverse()) {
                parts.push(digest.reflectionText);
                parts.push('');
            }
        }
        // Complete reflection history
        const reflectionContext = await this.buildReflectionContext({
            coupleId: args.coupleId,
            couple: args.couple,
        });
        if (reflectionContext) {
            parts.push('');
            parts.push(reflectionContext);
        }
        // Current homework reflections to discuss in this session
        const currentReflections = this.buildCurrentReflectionsForDiscussion(args.couple);
        if (currentReflections) {
            parts.push('');
            parts.push(currentReflections);
        }
        return parts.join('\n');
    }
}
