import { clerkMiddleware, getAuth } from '@clerk/express';
import type { RequestHandler } from 'express';
import { env } from '../Config/env.js';
import { HttpError } from '../Errors/HttpError.js';

const hasClerkConfig = Boolean(env.CLERK_SECRET_KEY && env.CLERK_PUBLISHABLE_KEY);

export const authenticationMiddleware: RequestHandler = hasClerkConfig
  ? clerkMiddleware({
      publishableKey: env.CLERK_PUBLISHABLE_KEY,
      secretKey: env.CLERK_SECRET_KEY,
    })
  : ((_req, _res, next) => next());

export const getAuthenticatedUserId = (request: Parameters<RequestHandler>[0]): string => {
  if (!hasClerkConfig) {
    const demoUserId = request.header('x-demo-user-id');
    if (demoUserId) {
      return demoUserId;
    }

    throw new HttpError(
      500,
      'Clerk is not configured on the backend. Add CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY, or send x-demo-user-id for local fallback.',
    );
  }

  const auth = getAuth(request);
  if (!auth.userId) {
    throw new HttpError(401, 'Authentication required.');
  }

  return auth.userId;
};
