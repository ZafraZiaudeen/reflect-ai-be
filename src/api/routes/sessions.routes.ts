import { Router } from 'express';
import { CoupleApplication } from '../../application/CoupleApplication.js';
import { SessionApplication } from '../../application/SessionApplication.js';
import { getAuthenticatedUserId } from '../../infrastructure/Auth/authentication.js';
import { HttpError } from '../../infrastructure/Errors/HttpError.js';
import { asyncHandler } from '../../infrastructure/Http/asyncHandler.js';
import { updateRoomModel } from '../../infrastructure/Voice/voiceWebSocket.js';

export const sessionsRouter = Router();

const getRouteParam = (value: string | string[] | undefined, name: string): string => {
  const nextValue = Array.isArray(value) ? value[0] : value;
  if (!nextValue) {
    throw new HttpError(400, `Missing required route param: ${name}`);
  }

  return nextValue;
};

sessionsRouter.post(
  '/',
  asyncHandler(async (request, response) => {
    const userId = getAuthenticatedUserId(request);
    const session = await SessionApplication.createSession(userId, request.body?.selectedModel);
    response.status(201).json(session);
  }),
);

sessionsRouter.get(
  '/',
  asyncHandler(async (request, response) => {
    const userId = getAuthenticatedUserId(request);
    const dashboard = await CoupleApplication.getDashboard(userId);
    response.json(dashboard.sessions);
  }),
);

sessionsRouter.get(
  '/:sessionId',
  asyncHandler(async (request, response) => {
    const userId = getAuthenticatedUserId(request);
    const sessionId = getRouteParam(request.params.sessionId, 'sessionId');
    const session = await SessionApplication.getSessionForUser(userId, sessionId);
    response.json(session);
  }),
);

sessionsRouter.post(
  '/:sessionId/complete',
  asyncHandler(async (request, response) => {
    const userId = getAuthenticatedUserId(request);
    const sessionId = getRouteParam(request.params.sessionId, 'sessionId');
    const session = await SessionApplication.completeSession(userId, sessionId);
    response.json(session);
  }),
);

sessionsRouter.patch(
  '/:sessionId/homework',
  asyncHandler(async (request, response) => {
    const userId = getAuthenticatedUserId(request);
    const sessionId = getRouteParam(request.params.sessionId, 'sessionId');
    const couple = await SessionApplication.submitHomeworkReflection(
      userId,
      sessionId,
      request.body,
    );
    response.json(couple);
  }),
);

sessionsRouter.patch(
  '/:sessionId/model',
  asyncHandler(async (request, response) => {
    const userId = getAuthenticatedUserId(request);
    const sessionId = getRouteParam(request.params.sessionId, 'sessionId');
    const modelId: string | undefined = request.body?.modelId;
    if (!modelId) throw new HttpError(400, 'Missing modelId in request body.');
    const session = await SessionApplication.updateSessionModel(userId, sessionId, modelId);
    // Also update the live in-memory room immediately so the next utterance uses the new model.
    updateRoomModel(sessionId, modelId);
    response.json(session);
  }),
);

sessionsRouter.post(
  '/:sessionId/transcripts',
  asyncHandler(async (request, response) => {
    const userId = getAuthenticatedUserId(request);
    const sessionId = getRouteParam(request.params.sessionId, 'sessionId');
    const session = await SessionApplication.appendPartnerTranscript(
      userId,
      sessionId,
      request.body,
    );
    response.status(201).json(session);
  }),
);
