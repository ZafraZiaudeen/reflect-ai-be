import { CoupleModel, type CoupleDocument } from '../domain/Models/Couple.js';
import { SessionModel, type SessionDocument } from '../domain/Models/Session.js';
import { UserProfileModel } from '../domain/Models/UserProfile.js';
import { createInviteCode, getSessionStartBlocker } from '../domain/Rules/sessionRules.js';
import {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  getModelOption,
  toObjectIdString,
  type CoupleSummary,
  type CreateCoupleInput,
  type DashboardResponse,
  type JoinCoupleInput,
  type ModelOption,
  type SessionSummary,
} from '../domain/Types/mirror.js';
import { HttpError } from '../infrastructure/Errors/HttpError.js';

const findCoupleByUserId = async (userId: string): Promise<CoupleDocument | null> =>
  CoupleModel.findOne({
    $or: [{ partnerAUserId: userId }, { partnerBUserId: userId }],
  });

const ensureUserProfile = async (userId: string, input: CreateCoupleInput): Promise<void> => {
  await UserProfileModel.findOneAndUpdate(
    { clerkUserId: userId },
    {
      clerkUserId: userId,
      displayName: input.displayName || 'Mirror Partner',
      email: input.email,
      avatarUrl: input.avatarUrl,
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    },
  );
};

const mapCoupleSummary = (couple: CoupleDocument): CoupleSummary => ({
  id: toObjectIdString(couple._id),
  inviteCode: couple.inviteCode,
  preferredModel: couple.preferredModel,
  partnerA: {
    userId: couple.partnerAUserId,
    displayName: couple.partnerAName,
    email: couple.partnerAEmail,
  },
  partnerB: couple.partnerBUserId
    ? {
        userId: couple.partnerBUserId,
        displayName: couple.partnerBName || 'Partner B',
        email: couple.partnerBEmail,
      }
    : undefined,
  memorySummary: couple.memorySummary,
  activeHomeworkGate: couple.activeHomeworkGate ?? null,
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

export class CoupleApplication {
  static async createCouple(userId: string, input: CreateCoupleInput): Promise<CoupleSummary> {
    await ensureUserProfile(userId, input);

    const existingCouple = await findCoupleByUserId(userId);
    if (existingCouple) {
      throw new HttpError(409, 'This user is already attached to a couple workspace.');
    }

    const couple = await CoupleModel.create({
      inviteCode: createInviteCode(),
      partnerAUserId: userId,
      partnerAName: input.displayName || 'Partner A',
      partnerAEmail: input.email,
      partnerAAvatarUrl: input.avatarUrl,
      preferredModel: DEFAULT_MODEL_ID,
      memorySummary: '',
      activeHomeworkGate: null,
    });

    return mapCoupleSummary(couple);
  }

  static async joinCouple(userId: string, input: JoinCoupleInput): Promise<CoupleSummary> {
    await ensureUserProfile(userId, input);

    const existingCouple = await findCoupleByUserId(userId);
    if (existingCouple) {
      throw new HttpError(409, 'This user is already attached to a couple workspace.');
    }

    const couple = await CoupleModel.findOne({ inviteCode: input.inviteCode.trim().toUpperCase() });
    if (!couple) {
      throw new HttpError(404, 'Invite code not found.');
    }
    if (couple.partnerBUserId) {
      throw new HttpError(409, 'This couple workspace already has two partners.');
    }
    if (couple.partnerAUserId === userId) {
      throw new HttpError(409, 'You cannot join your own invite as the second partner.');
    }

    couple.partnerBUserId = userId;
    couple.partnerBName = input.displayName || 'Partner B';
    couple.partnerBEmail = input.email;
    couple.partnerBAvatarUrl = input.avatarUrl;
    await couple.save();

    return mapCoupleSummary(couple);
  }

  static async updatePreferredModel(userId: string, modelId: string): Promise<ModelOption> {
    const couple = await findCoupleByUserId(userId);
    if (!couple) {
      throw new HttpError(404, 'Couple workspace not found.');
    }

    const model = getModelOption(modelId);
    couple.preferredModel = model.id;
    await couple.save();

    return model;
  }

  static async getDashboard(userId: string): Promise<DashboardResponse> {
    const couple = await findCoupleByUserId(userId);

    if (!couple) {
      return {
        couple: null,
        sessions: [],
        models: MODEL_CATALOG,
        canStartSession: false,
        blockerReason: 'Create or join a couple workspace before opening a session.',
      };
    }

    const sessions = await SessionModel.find({ coupleId: couple._id }).sort({ createdAt: -1 }).limit(12);
    const blockerReason =
      !couple.partnerBUserId
        ? 'Invite the second partner before opening the room.'
        : getSessionStartBlocker(couple.activeHomeworkGate);

    return {
      couple: mapCoupleSummary(couple),
      sessions: sessions.map(mapSessionSummary),
      models: MODEL_CATALOG,
      canStartSession: !blockerReason,
      blockerReason: blockerReason ?? undefined,
    };
  }
}
