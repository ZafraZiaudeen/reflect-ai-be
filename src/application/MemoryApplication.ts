import { Types } from 'mongoose';
import {
  ReflectionMemoryModel,
  type ReflectionMemoryDocument,
} from '../domain/Models/ReflectionMemory.js';
import type { CoupleDocument } from '../domain/Models/Couple.js';
import { generateEmbedding, cosineSimilarity } from '../infrastructure/Embeddings/embeddingService.js';
import { toObjectIdString } from '../domain/Types/mirror.js';
import {
  getPartnerDisplayName,
  normalizeHomeworkGateForCouple,
} from './HomeworkGateApplication.js';

const summarizeInline = (text: string, maxLength = 100): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'No reflection submitted.';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
};

export class MemoryApplication {
  static async storeReflection(args: {
    coupleId: string;
    sessionId: string;
    userId: string;
    partnerRole: 'partner_a' | 'partner_b';
    partnerName: string;
    assignmentTitle: string;
    reflectionPrompt: string;
    reflectionText: string;
    sessionSummary?: string;
  }): Promise<void> {
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
      await ReflectionMemoryModel.findOneAndUpdate(
        {
          coupleId: new Types.ObjectId(args.coupleId),
          sessionId: new Types.ObjectId(args.sessionId),
          memoryType: 'reflection',
          userId: args.userId,
          assignmentTitle: args.assignmentTitle,
        },
        {
          $set: {
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
        },
        { upsert: true },
      );
    } catch (error) {
      console.warn('[memory] Failed to store reflection embedding:', error);
    }
  }

  static async storeSessionSummary(args: {
    coupleId: string;
    sessionId: string;
    truthSummary: string;
    coreConflict: string;
    observedPatterns: string[];
  }): Promise<void> {
    try {
      const summaryText = [
        `Session Summary: ${args.truthSummary}`,
        `Core conflict: ${args.coreConflict}`,
        `Observed patterns: ${args.observedPatterns.join(', ')}`,
      ].join('. ');

      const embedding = await generateEmbedding(summaryText);

      await ReflectionMemoryModel.findOneAndUpdate(
        {
          coupleId: new Types.ObjectId(args.coupleId),
          sessionId: new Types.ObjectId(args.sessionId),
          memoryType: 'session_summary',
          userId: 'system',
          assignmentTitle: 'Session Summary',
        },
        {
          $set: {
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
        },
        { upsert: true },
      );
    } catch (error) {
      console.warn('[memory] Failed to store session summary embedding:', error);
    }
  }

  static async storeConversationDigest(args: {
    coupleId: string;
    sessionId: string;
    digestText: string;
    sessionSummary?: string;
  }): Promise<void> {
    try {
      const embedding = await generateEmbedding(args.digestText);

      await ReflectionMemoryModel.findOneAndUpdate(
        {
          coupleId: new Types.ObjectId(args.coupleId),
          sessionId: new Types.ObjectId(args.sessionId),
          memoryType: 'conversation_digest',
          userId: 'system',
          assignmentTitle: 'Conversation Digest',
        },
        {
          $set: {
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
        },
        { upsert: true },
      );
    } catch (error) {
      console.warn('[memory] Failed to store conversation digest embedding:', error);
    }
  }

  static async getAllReflections(coupleId: string): Promise<ReflectionMemoryDocument[]> {
    return ReflectionMemoryModel.find({
      coupleId: new Types.ObjectId(coupleId),
      memoryType: 'reflection',
      userId: { $ne: 'system' },
    })
      .sort({ createdAt: 1 })
      .exec();
  }

  static async getAllSessionSummaries(coupleId: string): Promise<ReflectionMemoryDocument[]> {
    return ReflectionMemoryModel.find({
      coupleId: new Types.ObjectId(coupleId),
      memoryType: 'session_summary',
      userId: 'system',
    })
      .sort({ createdAt: 1 })
      .exec();
  }

  static async getRecentConversationDigests(
    coupleId: string,
    limit = 4,
  ): Promise<ReflectionMemoryDocument[]> {
    return ReflectionMemoryModel.find({
      coupleId: new Types.ObjectId(coupleId),
      memoryType: 'conversation_digest',
      userId: 'system',
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }

  static async searchSimilarReflections(args: {
    coupleId: string;
    query: string;
    limit?: number;
  }): Promise<Array<ReflectionMemoryDocument & { similarity: number }>> {
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
    } catch {
      // Atlas Vector Search not available — fall through to manual approach
    }

    // Fallback: manual cosine similarity
    const allMemories = await ReflectionMemoryModel.find({
      coupleId: new Types.ObjectId(args.coupleId),
    }).exec();

    return allMemories
      .filter((mem) => mem.embedding && mem.embedding.length > 0 && mem.embedding.some((v) => v !== 0))
      .map((mem) => {
        const doc = mem.toObject() as ReflectionMemoryDocument & { similarity: number };
        (doc as unknown as Record<string, unknown>).similarity = cosineSimilarity(queryEmbedding.vector, mem.embedding);
        return doc;
      })
      .sort((a, b) => (b as unknown as { similarity: number }).similarity - (a as unknown as { similarity: number }).similarity)
      .slice(0, limit) as unknown as Array<ReflectionMemoryDocument & { similarity: number }>;
  }

  static async buildReflectionContext(args: {
    coupleId: string;
    couple: CoupleDocument;
  }): Promise<string> {
    const allReflections = await this.getAllReflections(args.coupleId);

    if (allReflections.length === 0) {
      return '';
    }

    const partnerAName = args.couple.partnerAName;
    const partnerBName = args.couple.partnerBName || 'Partner B';

    const parts: string[] = [
      '=== COMPLETE REFLECTION HISTORY (ALL SESSIONS) ===',
      `Total reflections on record: ${allReflections.length}`,
      '',
    ];

    // Group by session
    const bySession = new Map<string, ReflectionMemoryDocument[]>();
    for (const ref of allReflections) {
      const key = toObjectIdString(ref.sessionId);
      if (!bySession.has(key)) {
        bySession.set(key, []);
      }
      bySession.get(key)!.push(ref);
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

  static buildCurrentReflectionsForDiscussion(couple: CoupleDocument): string {
    const { gate } = normalizeHomeworkGateForCouple(couple);
    if (!gate || gate.assignments.length === 0) {
      return '';
    }

    const parts: string[] = [
      '=== REFLECTIONS TO DISCUSS THIS SESSION ===',
      'YOU MUST review these reflections with both partners before moving to any other topic.',
      'Read their words back to them. Ask if they meant it. Push for honesty.',
      '',
    ];

    for (const assignment of gate.assignments) {
      const partnerName = getPartnerDisplayName(couple, assignment.targetPartnerRole);
      parts.push(`Assignment: "${assignment.title}"`);
      parts.push(`Assigned to: ${partnerName}`);
      parts.push(`Description: ${assignment.description}`);
      parts.push(`Prompt: "${assignment.reflectionPrompt}"`);
      parts.push('');

      if (assignment.submission?.reflection.trim()) {
        parts.push(`  ${partnerName} wrote (completed: ${assignment.submission.completed}):`);
        parts.push(`  "${assignment.submission.reflection}"`);
      } else {
        parts.push(`  ${partnerName} DID NOT submit a reflection. Confront them about this.`);
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  static buildReflectionOpeningLine(
    couple: CoupleDocument,
    options?: {
      presentPartnerRole?: 'partner_a' | 'partner_b';
    },
  ): string {
    const { gate } = normalizeHomeworkGateForCouple(couple);
    if (!gate || gate.assignments.length === 0) {
      return '';
    }

    const describePartner = (
      partnerRole: 'partner_a' | 'partner_b',
      partnerName: string,
    ): string => {
      const assignment = gate.assignments.find((entry) => entry.targetPartnerRole === partnerRole);
      if (!assignment) {
        return `${partnerName}, there is no saved homework from you yet.`;
      }

      if (!assignment.submission?.reflection.trim()) {
        return `${partnerName}, you have not submitted your reflection for "${assignment.title}" yet.`;
      }

      return `${partnerName}, you wrote ${assignment.title}: "${summarizeInline(assignment.submission.reflection, 88)}".`;
    };

    const partnerALine = describePartner('partner_a', couple.partnerAName);
    const partnerBLine = describePartner('partner_b', couple.partnerBName || 'Partner B');

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

  static buildEnrichedOpeningContext(args: {
    couple: CoupleDocument;
  }): string {
    const parts: string[] = [];

    if (args.couple.memorySummary) {
      parts.push('=== RELATIONSHIP MEMORY (all sessions summarised) ===');
      parts.push(args.couple.memorySummary);
    } else {
      parts.push("This is the couple's first session — no prior memory exists yet.");
    }

    const currentReflections = this.buildCurrentReflectionsForDiscussion(args.couple);
    if (currentReflections) {
      parts.push('');
      parts.push(currentReflections);
    }

    return parts.join('\n');
  }
}
