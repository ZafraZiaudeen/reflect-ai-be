import { Router } from 'express';
import { CoupleApplication } from '../../application/CoupleApplication.js';
import { getAuthenticatedUserId } from '../../infrastructure/Auth/authentication.js';
import { asyncHandler } from '../../infrastructure/Http/asyncHandler.js';

export const couplesRouter = Router();

couplesRouter.post(
  '/',
  asyncHandler(async (request, response) => {
    const userId = getAuthenticatedUserId(request);
    const couple = await CoupleApplication.createCouple(userId, request.body ?? {});
    response.status(201).json(couple);
  }),
);

couplesRouter.post(
  '/join',
  asyncHandler(async (request, response) => {
    const userId = getAuthenticatedUserId(request);
    const couple = await CoupleApplication.joinCouple(userId, request.body);
    response.json(couple);
  }),
);

couplesRouter.post(
  '/invitations',
  asyncHandler(async (request, response) => {
    const userId = getAuthenticatedUserId(request);
    const couple = await CoupleApplication.sendWorkspaceInvite(userId, request.body ?? {});
    response.json(couple);
  }),
);

couplesRouter.patch(
  '/preferences',
  asyncHandler(async (request, response) => {
    const userId = getAuthenticatedUserId(request);
    const model = await CoupleApplication.updatePreferredModel(userId, request.body?.modelId);
    response.json(model);
  }),
);

couplesRouter.delete(
  '/partner',
  asyncHandler(async (request, response) => {
    const userId = getAuthenticatedUserId(request);
    const couple = await CoupleApplication.removePartner(userId);
    response.json(couple);
  }),
);

couplesRouter.post(
  '/leave',
  asyncHandler(async (request, response) => {
    const userId = getAuthenticatedUserId(request);
    const result = await CoupleApplication.leaveWorkspace(userId);
    response.json(result);
  }),
);
