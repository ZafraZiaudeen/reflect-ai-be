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
  type HomeworkReflectionInput,
  type PartnerTranscriptInput,
  type SessionSummary,
} from '../domain/Types/mirror.js';
import { HttpError } from '../infrastructure/Errors/HttpError.js';
import { generateTruthReport } from '../infrastructure/OpenRouter/openRouterService.js';
import { MemoryApplication } from './MemoryApplication.js';
import { analyzeSessionHonesty } from '../infrastructure/Embeddings/embeddingService.js';

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

const clearStaleHomeworkGateIfNeeded = async (couple: CoupleDocument): Promise<void> => {
  const gate = couple.activeHomeworkGate;
  if (!gate) {
    return;
  }

  const sourceSession = await SessionModel.findById(gate.sourceSessionId);
  if (!sourceSession) {
    couple.activeHomeworkGate = null;
    await couple.save();
    return;
  }

  const isMeaningful = isMeaningfulSessionAttempt({
    transcriptSegments: sourceSession.transcriptSegments,
    interventions: sourceSession.interventions,
    metrics: sourceSession.metrics,
  });

  if (isMeaningful) {
    return;
  }

  couple.activeHomeworkGate = null;
  await couple.save();
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

    await clearStaleHomeworkGateIfNeeded(couple);

    const blockerReason = getSessionStartBlocker(couple.activeHomeworkGate);
    if (blockerReason) {
      throw new HttpError(409, blockerReason);
    }

    const model = getModelOption(selectedModel || couple.preferredModel);
    couple.preferredModel = model.id;
    await couple.save();

    // Build enriched opening context using vector memory (all past reflections + sessions)
    let openingContext: string;
    try {
      openingContext = await MemoryApplication.buildEnrichedOpeningContext({
        coupleId: toObjectIdString(couple._id),
        couple,
        previousSummary: couple.memorySummary,
      });
    } catch (error) {
      console.warn('[session] Failed to build enriched context, falling back to basic:', error);
      openingContext = buildSessionContextSummary(couple.memorySummary, couple.activeHomeworkGate);
    }

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
  ): Promise<CoupleDocument> {
    const couple = await findCoupleByUserId(userId);
    if (!couple) {
      throw new HttpError(404, 'Couple workspace not found.');
    }

    const gate = couple.activeHomeworkGate;
    if (!gate || gate.sourceSessionId !== sessionId) {
      throw new HttpError(404, 'No active homework gate was found for this session.');
    }

    const assignment = gate.assignments.find((item) => item.id === input.assignmentId);
    if (!assignment) {
      throw new HttpError(404, 'Homework assignment not found.');
    }

    assignment.reflections = assignment.reflections.filter((reflection) => reflection.userId !== userId);
    assignment.reflections.push({
      userId,
      completed: input.completed,
      reflection: input.reflection.trim(),
      submittedAt: new Date(),
    });

    const everyAssignmentCovered = gate.assignments.every(
      (item) => item.reflections.length >= gate.requiredReflections,
    );
    gate.unlockedAt = everyAssignmentCovered ? new Date() : null;

    await couple.save();

    // Store reflection in vector memory for future sessions
    const isPartnerA = couple.partnerAUserId === userId;
    void MemoryApplication.storeReflection({
      coupleId: toObjectIdString(couple._id),
      sessionId,
      userId,
      partnerRole: isPartnerA ? 'partner_a' : 'partner_b',
      partnerName: isPartnerA ? couple.partnerAName : (couple.partnerBName || 'Partner B'),
      assignmentTitle: assignment.title,
      reflectionPrompt: assignment.reflectionPrompt,
      reflectionText: input.reflection.trim(),
      sessionSummary: couple.memorySummary,
    }).catch((error) => {
      console.warn('[session] Failed to store reflection in vector memory:', error);
    });

    return couple;
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

      couple.memorySummary = report.truthSummary;
      couple.activeHomeworkGate = {
        sourceSessionId: toObjectIdString(session._id),
        createdAt: new Date(),
        requiredReflections: couple.partnerBUserId ? 2 : 1,
        unlockedAt: null,
        assignments: report.homework.map((assignment) => ({
          ...assignment,
          reflections: [],
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
    const gateSummary =
      couple.activeHomeworkGate?.assignments.map((assignment) => assignment.title).join(' | ') ||
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

    const homeworkTitle = couple.activeHomeworkGate?.assignments[0]?.title;
    if (homeworkTitle) {
      metadata.homeworkTitle = homeworkTitle;
    }

    // Include reflection context for the AI to discuss
    const reflectionContext = MemoryApplication.buildCurrentReflectionsForDiscussion(couple);
    if (reflectionContext) {
      metadata.reflectionContext = reflectionContext;
      metadata.hasReflections = 'true';
    }

    return metadata;
  }
}
