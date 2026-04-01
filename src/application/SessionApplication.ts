import { CoupleModel, type CoupleDocument } from '../domain/Models/Couple.js';
import { SessionModel, type SessionDocument } from '../domain/Models/Session.js';
import {
  buildSessionContextSummary,
  getSessionStartBlocker,
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

export class SessionApplication {
  static async createSession(userId: string, selectedModel?: string): Promise<SessionSummary> {
    const couple = await findCoupleByUserId(userId);
    if (!couple) {
      throw new HttpError(404, 'Couple workspace not found.');
    }
    if (!couple.partnerBUserId) {
      throw new HttpError(409, 'Both partners must join before a session can start.');
    }

    const blockerReason = getSessionStartBlocker(couple.activeHomeworkGate);
    if (blockerReason) {
      throw new HttpError(409, blockerReason);
    }

    const model = getModelOption(selectedModel || couple.preferredModel);
    couple.preferredModel = model.id;
    await couple.save();

    const session = await SessionModel.create({
      coupleId: couple._id,
      roomName: createRoomName(toObjectIdString(couple._id)),
      status: 'pending',
      selectedModel: model.id,
      openingContext: buildSessionContextSummary(couple.memorySummary, couple.activeHomeworkGate),
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

    if (!session.report) {
      const report = await generateTruthReport({
        selectedModel: session.selectedModel,
        transcriptSegments: session.transcriptSegments,
        interventions: session.interventions,
        previousSummary: couple.memorySummary,
      });

      session.report = report;
      session.metrics.honestyScore = report.honestyScore;
      session.endedAt = session.endedAt ?? new Date();
      session.startedAt = session.startedAt ?? session.createdAt;
      session.metrics.durationMs = Math.max(0, session.endedAt.getTime() - session.startedAt.getTime());
      session.status = session.status === 'interrupted' ? 'interrupted' : 'completed';
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

    return {
      sessionId: toObjectIdString(session._id),
      coupleId: toObjectIdString(couple._id),
      selectedModel: session.selectedModel,
      openingContext: session.openingContext,
      gateSummary,
      partnerAName: couple.partnerAName,
      partnerBName: couple.partnerBName || 'Partner B',
    };
  }
}
