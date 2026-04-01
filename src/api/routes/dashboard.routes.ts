import { Router } from 'express';
import { CoupleApplication } from '../../application/CoupleApplication.js';
import { getAuthenticatedUserId } from '../../infrastructure/Auth/authentication.js';
import { asyncHandler } from '../../infrastructure/Http/asyncHandler.js';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/',
  asyncHandler(async (request, response) => {
    const userId = getAuthenticatedUserId(request);
    const dashboard = await CoupleApplication.getDashboard(userId);
    response.json(dashboard);
  }),
);
