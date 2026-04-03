import { CoupleModel } from '../domain/Models/Couple.js';
import { SessionModel } from '../domain/Models/Session.js';
import { UserProfileModel } from '../domain/Models/UserProfile.js';
import { createInviteCode, getSessionStartBlocker, isMeaningfulSessionAttempt, } from '../domain/Rules/sessionRules.js';
import { DEFAULT_MODEL_ID, MODEL_CATALOG, getModelOption, toObjectIdString, } from '../domain/Types/mirror.js';
import { env } from '../infrastructure/Config/env.js';
import { HttpError } from '../infrastructure/Errors/HttpError.js';
import { canSendWorkspaceInvitationEmails, sendWorkspaceInvitationEmail, } from '../infrastructure/Email/workspaceInviteMailer.js';
const findCoupleByUserId = async (userId) => CoupleModel.findOne({
    $or: [{ partnerAUserId: userId }, { partnerBUserId: userId }],
});
const ensureUserProfile = async (userId, input) => {
    await UserProfileModel.findOneAndUpdate({ clerkUserId: userId }, {
        clerkUserId: userId,
        displayName: input.displayName || 'Mirror Partner',
        email: input.email,
        avatarUrl: input.avatarUrl,
    }, {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
    });
};
const getPrimaryClientUrl = () => env.CLIENT_URL.split(',')
    .map((value) => value.trim())
    .find(Boolean) || 'http://localhost:5173';
const buildInvitationUrl = (path, inviteCode, email) => {
    const url = new URL(path, getPrimaryClientUrl());
    url.searchParams.set('invite', inviteCode);
    if (email) {
        url.searchParams.set('email', email);
    }
    return url.toString();
};
export const mapCoupleSummary = (couple) => ({
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
    pendingInvitation: couple.pendingInvitation ?? null,
});
const mapSessionSummary = (session) => ({
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
const clearStaleHomeworkGateIfNeeded = async (couple) => {
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
export class CoupleApplication {
    static async createCouple(userId, input) {
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
            pendingInvitation: null,
        });
        return mapCoupleSummary(couple);
    }
    static async joinCouple(userId, input) {
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
        couple.pendingInvitation = null;
        await couple.save();
        return mapCoupleSummary(couple);
    }
    static async sendWorkspaceInvite(userId, input) {
        const couple = await findCoupleByUserId(userId);
        if (!couple) {
            throw new HttpError(404, 'Create a couple workspace before sending an invitation.');
        }
        if (couple.partnerBUserId) {
            throw new HttpError(409, 'Both partners are already connected to this workspace.');
        }
        if (!canSendWorkspaceInvitationEmails()) {
            throw new HttpError(500, 'SMTP invite email is not configured on the backend. Add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM.');
        }
        const email = input.email?.trim().toLowerCase();
        if (!email) {
            throw new HttpError(400, 'Invitation email is required.');
        }
        if (couple.partnerAEmail?.trim().toLowerCase() === email) {
            throw new HttpError(400, "Use your partner's email address for the invitation.");
        }
        const inviterName = couple.partnerAUserId === userId ? couple.partnerAName : couple.partnerBName || couple.partnerAName;
        const recipientName = input.recipientName?.trim() || undefined;
        const signUpUrl = buildInvitationUrl('/sign-up', couple.inviteCode, email);
        const signInUrl = buildInvitationUrl('/sign-in', couple.inviteCode, email);
        await sendWorkspaceInvitationEmail({
            toEmail: email,
            recipientName,
            inviterName,
            inviteCode: couple.inviteCode,
            signUpUrl,
            signInUrl,
        });
        couple.pendingInvitation = {
            email,
            recipientName,
            invitedByUserId: userId,
            invitedByName: inviterName,
            sentAt: new Date(),
        };
        await couple.save();
        return mapCoupleSummary(couple);
    }
    static async updatePreferredModel(userId, modelId) {
        const couple = await findCoupleByUserId(userId);
        if (!couple) {
            throw new HttpError(404, 'Couple workspace not found.');
        }
        const model = getModelOption(modelId);
        couple.preferredModel = model.id;
        await couple.save();
        return model;
    }
    static async removePartner(userId) {
        const couple = await findCoupleByUserId(userId);
        if (!couple) {
            throw new HttpError(404, 'Couple workspace not found.');
        }
        if (couple.partnerAUserId !== userId) {
            throw new HttpError(403, 'Only the partner who created the workspace can remove the second partner.');
        }
        if (!couple.partnerBUserId) {
            throw new HttpError(409, 'There is no second partner attached to this workspace.');
        }
        couple.partnerBUserId = undefined;
        couple.partnerBName = undefined;
        couple.partnerBEmail = undefined;
        couple.partnerBAvatarUrl = undefined;
        couple.activeHomeworkGate = null;
        couple.pendingInvitation = null;
        couple.inviteCode = createInviteCode();
        await couple.save();
        return mapCoupleSummary(couple);
    }
    static async leaveWorkspace(userId) {
        const couple = await findCoupleByUserId(userId);
        if (!couple) {
            throw new HttpError(404, 'Couple workspace not found.');
        }
        if (couple.partnerBUserId === userId) {
            couple.partnerBUserId = undefined;
            couple.partnerBName = undefined;
            couple.partnerBEmail = undefined;
            couple.partnerBAvatarUrl = undefined;
            couple.activeHomeworkGate = null;
            couple.pendingInvitation = null;
            couple.inviteCode = createInviteCode();
            await couple.save();
            return { leftWorkspace: true };
        }
        if (couple.partnerAUserId !== userId) {
            throw new HttpError(403, 'You are not attached to this workspace.');
        }
        if (couple.partnerBUserId) {
            couple.partnerAUserId = couple.partnerBUserId;
            couple.partnerAName = couple.partnerBName || 'Partner A';
            couple.partnerAEmail = couple.partnerBEmail;
            couple.partnerAAvatarUrl = couple.partnerBAvatarUrl;
            couple.partnerBUserId = undefined;
            couple.partnerBName = undefined;
            couple.partnerBEmail = undefined;
            couple.partnerBAvatarUrl = undefined;
            couple.activeHomeworkGate = null;
            couple.pendingInvitation = null;
            couple.inviteCode = createInviteCode();
            await couple.save();
            return { leftWorkspace: true };
        }
        await CoupleModel.deleteOne({ _id: couple._id });
        return { leftWorkspace: true };
    }
    static async getDashboard(userId) {
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
        await clearStaleHomeworkGateIfNeeded(couple);
        const sessions = await SessionModel.find({ coupleId: couple._id }).sort({ createdAt: -1 }).limit(12);
        const activeSession = sessions.find((s) => s.status === 'pending' || s.status === 'live') ?? null;
        const blockerReason = !couple.partnerBUserId
            ? 'Invite the second partner before opening the room.'
            : getSessionStartBlocker(couple.activeHomeworkGate);
        return {
            couple: mapCoupleSummary(couple),
            sessions: sessions.map(mapSessionSummary),
            models: MODEL_CATALOG,
            canStartSession: !blockerReason,
            blockerReason: blockerReason ?? undefined,
            activeSession: activeSession ? mapSessionSummary(activeSession) : null,
        };
    }
}
