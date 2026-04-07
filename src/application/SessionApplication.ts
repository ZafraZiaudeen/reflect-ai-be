import { CoupleModel, type CoupleDocument } from '../domain/Models/Couple.js';
import { SessionModel, type SessionDocument } from '../domain/Models/Session.js';
import {
  buildSessionContextSummary,
  getSessionStartBlocker,
  isMeaningfulSessionAttempt,
} from '../domain/Rules/sessionRules.js';
import {
  getModelOption,
  toObjectIdString,
  type CoupleSummary,
  type HomeworkReflectionInput,
  type PartnerTranscriptInput,
  type SessionSummary,
} from '../domain/Types/mirror.js';
import { HttpError } from '../infrastructure/Errors/HttpError.js';
import { generateCumulativeSummary, generateTruthReport } from '../infrastructure/OpenRouter/openRouterService.js';
import { MemoryApplication } from './MemoryApplication.js';
import { analyzeSessionHonesty } from '../infrastructure/Embeddings/embeddingService.js';
import { mapCoupleSummary } from './CoupleApplication.js';
import {
  ensureHomeworkGateIntegrity,
  normalizeHomeworkGateForCouple,
} from './HomeworkGateApplication.js';

const findCoupleByUserId = async (userId: string): Promise<CoupleDocument | null> =>
  CoupleModel.findOne({
    $or: [{ partnerAUserId: userId }, { partnerBUserId: userId }],
  });

const mapSessionSummary = (session: SessionDocument): SessionSummary => ({
  id: toObjectIdString(session._id),
  coupleId: toObjectIdString(session.coupleId),
  roomName: session.roomName,
  status: session.status,
  selectedModel: session.selectedModel,
  createdByUserId: session.createdByUserId || '',
  startedAt: session.startedAt?.toISOString() ?? null,
  endedAt: session.endedAt?.toISOString() ?? null,
  report: session.report ?? null,
  transcriptSegments: session.transcriptSegments,
  interventions: session.interventions,
  metrics: session.metrics,
});

const resolveSpeaker = (couple: CoupleDocument, userId: string) => {
  if (couple.partnerAUserId === userId) {
    return {
      speakerRole: 'partner_a' as const,
      speakerLabel: couple.partnerAName,
    };
  }

  if (couple.partnerBUserId === userId) {
    return {
      speakerRole: 'partner_b' as const,
      speakerLabel: couple.partnerBName || 'Partner B',
    };
  }

  throw new HttpError(403, 'You are not attached to this couple workspace.');
};

const createRoomName = (coupleId: string): string => `mirror-${coupleId}-${Date.now()}`;

const ACCOUNTABILITY_PATTERNS = [
  /i realize/i,
  /i was wrong/i,
  /my fault/i,
  /i should have/i,
  /i'm sorry/i,
  /i take responsibility/i,
];

const clipLine = (text: string, maxLength = 140): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
};

const buildConversationDigest = (args: {
  session: SessionDocument;
  couple: CoupleDocument;
}): string => {
  const { session, couple } = args;
  const report = session.report;
  if (!report) {
    return '';
  }

  const partnerTurns = session.transcriptSegments.filter(
    (segment) => segment.speakerRole === 'partner_a' || segment.speakerRole === 'partner_b',
  );
  const accountabilityMoments = partnerTurns
    .filter((segment) => ACCOUNTABILITY_PATTERNS.some((pattern) => pattern.test(segment.text)))
    .slice(0, 4)
    .map((segment) => `${segment.speakerLabel}: "${clipLine(segment.text, 110)}"`);
  const interventions = session.interventions
    .slice(-3)
    .map((event) => `${event.severity} intervention: ${clipLine(event.line, 120)}`);
  const unresolvedMoments = partnerTurns
    .slice(-4)
    .map((segment) => `${segment.speakerLabel}: "${clipLine(segment.text, 100)}"`);

  return [
    `Conversation digest for ${couple.partnerAName} and ${couple.partnerBName || 'Partner B'}.`,
    `Core conflict: ${report.coreConflict}.`,
    `Truth summary: ${report.truthSummary}.`,
    `Observed patterns: ${report.observedPatterns.join(', ') || 'none clearly named'}.`,
    `Accountability moments: ${accountabilityMoments.join(' | ') || 'No clear accountability language was captured in this session.'}`,
    `Key interventions: ${interventions.join(' | ') || 'No direct therapist interventions were recorded.'}`,
    `Unresolved conflict points to revisit next session: ${report.nextGoal}.`,
    `Recent live quotes: ${unresolvedMoments.join(' | ') || 'Transcript sample was too short for quote excerpts.'}`,
  ].join('\n');
};

export class SessionApplication {
  static async createSession(userId: string, selectedModel?: string): Promise<SessionSummary> {
    const couple = await findCoupleByUserId(userId);
    if (!couple) {
      throw new HttpError(404, 'Couple workspace not found.');
    }
    if (!couple.partnerBUserId) {
      throw new HttpError(409, 'Both partners must join before a session can start.');
    }

    const { gate, changed } = await ensureHomeworkGateIntegrity(couple);
    if (changed) {
      await couple.save();
    }

    const blockerReason = getSessionStartBlocker(gate);
    if (blockerReason) {
      throw new HttpError(409, blockerReason);
    }

    const model = getModelOption(selectedModel || couple.preferredModel);
    couple.preferredModel = model.id;
    await couple.save();

    // Build opening context from the rolling cumulative summary + current homework reflections.
    // This is now synchronous and lean — no vector DB fan-out on session creation.
    const openingContext = MemoryApplication.buildEnrichedOpeningContext({ couple });

    const session = await SessionModel.create({
      coupleId: couple._id,
      roomName: createRoomName(toObjectIdString(couple._id)),
      status: 'pending',
      selectedModel: model.id,
      createdByUserId: userId,
      openingContext,
      transcriptSegments: [],
      interventions: [],
      metrics: {
        interventionCount: 0,
        overlapCount: 0,
        localTranscriptCount: 0,
        agentTranscriptCount: 0,
        honestyScore: 0,
        durationMs: 0,
      },
    });

    return mapSessionSummary(session);
  }

  static async getSessionForUser(userId: string, sessionId: string): Promise<SessionSummary> {
    const couple = await findCoupleByUserId(userId);
    if (!couple) {
      throw new HttpError(404, 'Couple workspace not found.');
    }

    const session = await SessionModel.findOne({ _id: sessionId, coupleId: couple._id });
    if (!session) {
      throw new HttpError(404, 'Session not found.');
    }

    return mapSessionSummary(session);
  }

  static async appendPartnerTranscript(
    userId: string,
    sessionId: string,
    input: PartnerTranscriptInput,
  ): Promise<SessionSummary> {
    const couple = await findCoupleByUserId(userId);
    if (!couple) {
      throw new HttpError(404, 'Couple workspace not found.');
    }

    const session = await SessionModel.findOne({ _id: sessionId, coupleId: couple._id });
    if (!session) {
      throw new HttpError(404, 'Session not found.');
    }

    const normalizedText = input.text.trim();
    if (!normalizedText) {
      throw new HttpError(400, 'Transcript text cannot be empty.');
    }

    const speaker = resolveSpeaker(couple, userId);
    session.transcriptSegments.push({
      speakerUserId: userId,
      speakerRole: speaker.speakerRole,
      speakerLabel: speaker.speakerLabel,
      text: normalizedText,
      createdAt: new Date(),
      startedAtMs: input.startedAtMs,
      endedAtMs: input.endedAtMs,
      confidence: input.confidence,
      source: 'frontend-webspeech',
      tags: [],
    });

    session.status = session.status === 'pending' ? 'live' : session.status;
    session.startedAt = session.startedAt ?? new Date();
    session.metrics.localTranscriptCount += 1;
    await session.save();

    return mapSessionSummary(session);
  }

  static async submitHomeworkReflection(
    userId: string,
    sessionId: string,
    input: HomeworkReflectionInput,
  ): Promise<CoupleSummary> {
    const couple = await findCoupleByUserId(userId);
    if (!couple) {
      throw new HttpError(404, 'Couple workspace not found.');
    }

    const { gate, changed } = await ensureHomeworkGateIntegrity(couple);
    if (changed) {
      await couple.save();
    }
    if (!gate || gate.sourceSessionId !== sessionId) {
      throw new HttpError(404, 'No active homework gate was found for this session.');
    }

    const speaker = resolveSpeaker(couple, userId);
    const assignment = gate.assignments.find(
      (item) => item.id === input.assignmentId && item.targetPartnerRole === speaker.speakerRole,
    );
    if (!assignment) {
      throw new HttpError(404, 'Homework assignment not found.');
    }

    const submission = {
      userId,
      completed: true,
      reflection: input.reflection.trim(),
      submittedAt: new Date(),
    };
    let updateResult = await CoupleModel.updateOne(
      {
        _id: couple._id,
        'activeHomeworkGate.sourceSessionId': sessionId,
      },
      {
        $set: {
          'activeHomeworkGate.assignments.$[assignment].submission': submission,
        },
      },
      {
        arrayFilters: [
          {
            'assignment.id': input.assignmentId,
            'assignment.targetPartnerRole': speaker.speakerRole,
          },
        ],
      },
    );

    if (updateResult.modifiedCount === 0) {
      updateResult = await CoupleModel.updateOne(
        {
          _id: couple._id,
          'activeHomeworkGate.sourceSessionId': sessionId,
        },
        {
          $set: {
            'activeHomeworkGate.assignments.$[assignment].submission': submission,
          },
        },
        {
          arrayFilters: [
            {
              'assignment.targetPartnerRole': speaker.speakerRole,
            },
          ],
        },
      );
    }

    if (updateResult.modifiedCount === 0) {
      throw new HttpError(409, 'The reflection could not be saved for this assignment. Please try again.');
    }

    const refreshedCouple = await CoupleModel.findById(couple._id);
    if (!refreshedCouple) {
      throw new HttpError(404, 'Couple workspace not found.');
    }

    const { gate: refreshedGate, changed: refreshedChanged } = await ensureHomeworkGateIntegrity(refreshedCouple);
    if (refreshedChanged) {
      await refreshedCouple.save();
    }
    if (!refreshedGate || refreshedGate.sourceSessionId !== sessionId) {
      throw new HttpError(404, 'No active homework gate was found for this session.');
    }

    const everyAssignmentCovered = refreshedGate.assignments.every(
      (item) => Boolean(item.submission?.submittedAt),
    );
    if (everyAssignmentCovered && !refreshedGate.unlockedAt) {
      const latestSubmittedAt =
        refreshedGate.assignments
          .map((item) => item.submission?.submittedAt)
          .filter((submittedAt): submittedAt is Date => Boolean(submittedAt))
          .sort((left, right) => right.getTime() - left.getTime())[0] ?? submission.submittedAt;

      refreshedCouple.activeHomeworkGate = {
        ...refreshedGate,
        unlockedAt: latestSubmittedAt,
      };
      await refreshedCouple.save();
    }

    // Store reflection in vector memory for future sessions
    void MemoryApplication.storeReflection({
      coupleId: toObjectIdString(couple._id),
      sessionId,
      userId,
      partnerRole: speaker.speakerRole,
      partnerName: speaker.speakerLabel,
      assignmentTitle: assignment.title,
      reflectionPrompt: assignment.reflectionPrompt,
      reflectionText: input.reflection.trim(),
      sessionSummary: refreshedCouple.memorySummary,
    }).catch((error) => {
      console.warn('[session] Failed to store reflection in vector memory:', error);
    });

    return mapCoupleSummary(refreshedCouple, userId, refreshedCouple.activeHomeworkGate ?? refreshedGate);
  }

  static async updateSessionModel(userId: string, sessionId: string, modelId: string): Promise<SessionSummary> {
    const couple = await findCoupleByUserId(userId);
    if (!couple) throw new HttpError(404, 'Couple workspace not found.');

    const session = await SessionModel.findOne({
      _id: sessionId,
      coupleId: couple._id,
      status: { $ne: 'completed' },
    });
    if (!session) throw new HttpError(404, 'Active session not found.');

    const model = getModelOption(modelId);
    session.selectedModel = model.id;
    await session.save();

    // Also persist as the couple preferred model so next new session inherits it.
    couple.preferredModel = model.id;
    await couple.save();

    return mapSessionSummary(session);
  }

  static async completeSession(userId: string, sessionId: string): Promise<SessionSummary> {
    const couple = await findCoupleByUserId(userId);
    if (!couple) {
      throw new HttpError(404, 'Couple workspace not found.');
    }

    const session = await SessionModel.findOne({ _id: sessionId, coupleId: couple._id });
    if (!session) {
      throw new HttpError(404, 'Session not found.');
    }

    const isMeaningful = isMeaningfulSessionAttempt({
      transcriptSegments: session.transcriptSegments,
      interventions: session.interventions,
      metrics: session.metrics,
    });

    if (!isMeaningful) {
      session.report = null;
      session.endedAt = session.endedAt ?? new Date();
      session.startedAt = session.startedAt ?? session.createdAt;
      session.metrics.durationMs = Math.max(0, session.endedAt.getTime() - session.startedAt.getTime());
      session.metrics.honestyScore = 0;
      session.status = 'interrupted';
      session.liveKitDispatchId = undefined;
      session.agentDispatchRequestedAt = undefined;
      await session.save();

      if (couple.activeHomeworkGate?.sourceSessionId === toObjectIdString(session._id)) {
        couple.activeHomeworkGate = null;
        await couple.save();
      }

      return mapSessionSummary(session);
    }

    if (!session.report) {
      // Get reflection history for dynamic homework generation
      let reflectionHistory = '';
      try {
        reflectionHistory = await MemoryApplication.buildReflectionContext({
          coupleId: toObjectIdString(couple._id),
          couple,
        });
      } catch {
        // Non-critical — report generation works without reflection history
      }

      const report = await generateTruthReport({
        selectedModel: session.selectedModel,
        transcriptSegments: session.transcriptSegments,
        interventions: session.interventions,
        previousSummary: couple.memorySummary,
        reflectionHistory,
      });

      // Validate and improve honesty score with HuggingFace analysis
      let finalHonestyScore = report.honestyScore;
      try {
        const partnerUtterances = session.transcriptSegments
          .filter((s) => s.source === 'livekit-user' || s.source === 'frontend-webspeech')
          .map((s) => ({ speaker: s.speakerLabel, text: s.text }));

        if (partnerUtterances.length >= 3) {
          const hfAnalysis = await analyzeSessionHonesty(partnerUtterances);
          // Combine LLM score (60% weight) with HuggingFace score (40% weight)
          finalHonestyScore = Math.round(report.honestyScore * 0.6 + hfAnalysis.score * 0.4);
          finalHonestyScore = Math.max(1, Math.min(100, finalHonestyScore));
        }
      } catch (error) {
        console.warn('[session] HuggingFace honesty analysis failed, using LLM score only:', error);
      }

      report.honestyScore = finalHonestyScore;
      session.report = report;
      session.metrics.honestyScore = finalHonestyScore;
      session.endedAt = session.endedAt ?? new Date();
      session.startedAt = session.startedAt ?? session.createdAt;
      session.metrics.durationMs = Math.max(0, session.endedAt.getTime() - session.startedAt.getTime());
      session.status = session.status === 'interrupted' ? 'interrupted' : 'completed';
      session.liveKitDispatchId = undefined;
      session.agentDispatchRequestedAt = undefined;
      await session.save();

      // Build rolling cumulative summary that narrates all sessions to date.
      // This replaces loading every past session individually next time.
      let cumulativeSummary = report.truthSummary;
      try {
        cumulativeSummary = await generateCumulativeSummary({
          existingSummary: couple.memorySummary || '',
          newSession: {
            coreConflict: report.coreConflict,
            truthSummary: report.truthSummary,
            observedPatterns: report.observedPatterns,
            nextGoal: report.nextGoal,
            homeworkTitles: report.homework.map((h) => h.title),
          },
          selectedModel: session.selectedModel,
        });
      } catch (error) {
        console.warn('[session] Cumulative summary generation failed, using plain truth summary:', error);
      }

      couple.memorySummary = cumulativeSummary;
      couple.activeHomeworkGate = {
        sourceSessionId: toObjectIdString(session._id),
        createdAt: new Date(),
        requiredReflections: couple.partnerBUserId ? 2 : 1,
        unlockedAt: null,
        assignments: report.homework.map((assignment) => ({
          ...assignment,
          submission: null,
        })),
      };
      await couple.save();

      // Store session summary in vector memory for future retrieval
      void MemoryApplication.storeSessionSummary({
        coupleId: toObjectIdString(couple._id),
        sessionId: toObjectIdString(session._id),
        truthSummary: report.truthSummary,
        coreConflict: report.coreConflict,
        observedPatterns: report.observedPatterns,
      }).catch((error) => {
        console.warn('[session] Failed to store session summary in vector memory:', error);
      });

      const conversationDigest = buildConversationDigest({ session, couple });
      if (conversationDigest) {
        void MemoryApplication.storeConversationDigest({
          coupleId: toObjectIdString(couple._id),
          sessionId: toObjectIdString(session._id),
          digestText: conversationDigest,
          sessionSummary: report.truthSummary,
        }).catch((error) => {
          console.warn('[session] Failed to store conversation digest in vector memory:', error);
        });
      }
    }

    return mapSessionSummary(session);
  }

  static async recordAgentDispatch(sessionId: string, dispatchId: string): Promise<void> {
    await SessionModel.findByIdAndUpdate(sessionId, {
      liveKitDispatchId: dispatchId,
      agentDispatchRequestedAt: new Date(),
    });
  }

  static buildOpeningMetadata(couple: CoupleDocument, session: SessionDocument): Record<string, string> {
    const { gate } = normalizeHomeworkGateForCouple(couple);
    const gateSummary =
      gate?.assignments.map((assignment) => assignment.title).join(' | ') ||
      'No pending homework gate.';

    const metadata: Record<string, string> = {
      sessionId: toObjectIdString(session._id),
      coupleId: toObjectIdString(couple._id),
      selectedModel: session.selectedModel,
      openingContext: session.openingContext,
      gateSummary,
      partnerAUserId: couple.partnerAUserId,
      partnerAName: couple.partnerAName,
      partnerBName: couple.partnerBName || 'Partner B',
    };

    if (couple.partnerBUserId) {
      metadata.partnerBUserId = couple.partnerBUserId;
    }

    const homeworkTitle = gate?.assignments[0]?.title;
    if (homeworkTitle) {
      metadata.homeworkTitle = homeworkTitle;
    }

    // Include reflection context for the AI to discuss
    const reflectionContext = MemoryApplication.buildCurrentReflectionsForDiscussion(couple);
    if (reflectionContext) {
      metadata.reflectionContext = reflectionContext;
      metadata.hasReflections = 'true';
      metadata.reflectionOpeningLine = MemoryApplication.buildReflectionOpeningLine(couple);
    }

    return metadata;
  }
}
