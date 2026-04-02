import { Router } from 'express';
import { SessionApplication } from '../../application/SessionApplication.js';
import { CoupleModel } from '../../domain/Models/Couple.js';
import { SessionModel } from '../../domain/Models/Session.js';
import {
  clearMirrorAgentDispatch,
  createParticipantToken,
  dispatchMirrorAgent,
} from '../../infrastructure/LiveKit/livekitService.js';
import { getAuthenticatedUserId } from '../../infrastructure/Auth/authentication.js';
import { HttpError } from '../../infrastructure/Errors/HttpError.js';
import { asyncHandler } from '../../infrastructure/Http/asyncHandler.js';
import {
  ensureLocalMirrorFallback,
  isLocalMirrorFallbackActive,
  isLocalMirrorFallbackEnabled,
} from '../../infrastructure/Voice/localMirrorFallback.js';

export const livekitRouter = Router();

const STALE_DISPATCH_REFRESH_MS = 12_000;

const isLiveKitNotFoundError = (error: unknown): error is { status: number; code?: string } =>
  typeof error === 'object' &&
  error !== null &&
  'status' in error &&
  (error as { status?: unknown }).status === 404;

livekitRouter.post(
  '/token',
  asyncHandler(async (request, response) => {
    const userId = getAuthenticatedUserId(request);
    const session = await SessionModel.findById(request.body?.sessionId);
    if (!session) {
      throw new HttpError(404, 'Session not found.');
    }

    const couple = await CoupleModel.findById(session.coupleId);
    if (!couple) {
      throw new HttpError(404, 'Couple workspace not found.');
    }
    if (couple.partnerAUserId !== userId && couple.partnerBUserId !== userId) {
      throw new HttpError(403, 'You cannot join this session.');
    }
    if (session.status === 'completed') {
      throw new HttpError(409, 'This session has already been completed and cannot be reopened.');
    }

    const hasNoAgentTurnsYet = (session.metrics.agentTranscriptCount ?? 0) === 0;
    const dispatchAgeMs = session.agentDispatchRequestedAt
      ? Date.now() - session.agentDispatchRequestedAt.getTime()
      : Number.POSITIVE_INFINITY;
    const shouldRefreshStaleDispatch =
      Boolean(session.liveKitDispatchId) && hasNoAgentTurnsYet && dispatchAgeMs > STALE_DISPATCH_REFRESH_MS;

    if (shouldRefreshStaleDispatch && session.liveKitDispatchId) {
      try {
        await clearMirrorAgentDispatch({
          roomName: session.roomName,
          dispatchId: session.liveKitDispatchId,
        });
      } catch (error) {
        if (!isLiveKitNotFoundError(error)) {
          console.warn('Mirror stale dispatch cleanup failed. Proceeding with a fresh dispatch request.', error);
        }
      }

      session.liveKitDispatchId = undefined;
      session.agentDispatchRequestedAt = undefined;
      await session.save();
    }

    const openingMetadata = SessionApplication.buildOpeningMetadata(couple, session);

    if (isLocalMirrorFallbackEnabled()) {
      try {
        await ensureLocalMirrorFallback({
          roomName: session.roomName,
          metadata: openingMetadata,
        });
      } catch (error) {
        console.warn('Mirror local fallback failed. The room can still open without the agent.', error);
      }
    } else if (!session.liveKitDispatchId && !isLocalMirrorFallbackActive(session.roomName)) {
      try {
        const dispatchId = await dispatchMirrorAgent({
          roomName: session.roomName,
          metadata: openingMetadata,
        });
        await SessionApplication.recordAgentDispatch(String(session._id), dispatchId);
        session.liveKitDispatchId = dispatchId;
      } catch (error) {
        console.warn('Mirror agent dispatch failed. The room can still open without the agent.', error);
      }
    }

    const token = await createParticipantToken({
      roomName: session.roomName,
      identity: `${String(session._id)}:${userId}`,
      name: couple.partnerAUserId === userId ? couple.partnerAName : couple.partnerBName || 'Partner B',
      metadata: {
        userId,
        sessionId: String(session._id),
        coupleId: String(couple._id),
        role: couple.partnerAUserId === userId ? 'partner_a' : 'partner_b',
      },
    });

    response.json(token);
  }),
);
