import { Router } from 'express';
import { SessionApplication } from '../../application/SessionApplication.js';
import { CoupleModel } from '../../domain/Models/Couple.js';
import { SessionModel } from '../../domain/Models/Session.js';
import {
  createParticipantToken,
  dispatchMirrorAgent,
} from '../../infrastructure/LiveKit/livekitService.js';
import { getAuthenticatedUserId } from '../../infrastructure/Auth/authentication.js';
import { HttpError } from '../../infrastructure/Errors/HttpError.js';
import { asyncHandler } from '../../infrastructure/Http/asyncHandler.js';

export const livekitRouter = Router();

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

    if (!session.liveKitDispatchId) {
      try {
        const dispatchId = await dispatchMirrorAgent({
          roomName: session.roomName,
          sessionId: String(session._id),
          coupleId: String(couple._id),
          selectedModel: session.selectedModel,
          openingContext: session.openingContext,
        });
        await SessionApplication.recordAgentDispatch(String(session._id), dispatchId);
        session.liveKitDispatchId = dispatchId;
      } catch (error) {
        console.warn('Mirror agent dispatch failed. The room can still open without the agent.', error);
      }
    }

    const token = await createParticipantToken({
      roomName: session.roomName,
      identity: `${userId}-${Date.now()}`,
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
