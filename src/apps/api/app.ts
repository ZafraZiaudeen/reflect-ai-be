import cors from 'cors';
import express, { type Express } from 'express';
import { apiRouter } from '../../api/index.js';
import { authenticationMiddleware } from '../../infrastructure/Auth/authentication.js';
import { env } from '../../infrastructure/Config/env.js';
import { connectDatabase } from '../../infrastructure/Database/connectDatabase.js';
import { errorMiddleware } from '../../infrastructure/Http/errorMiddleware.js';

const normalizeOrigin = (origin: string): string => {
  const trimmed = origin.trim();

  if (!trimmed) {
    return '';
  }

  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
};

const allowedOrigins = Array.from(
  new Set(
    [
      ...env.CLIENT_URL.split(',').map(normalizeOrigin),
      'http://localhost:5173',
    ].filter(Boolean),
  ),
);

const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (!origin) {
    return true;
  }

  return allowedOrigins.includes(normalizeOrigin(origin));
};

const corsOptions = {
  origin: (
    origin: string | undefined,
    callback: (error: Error | null, allow?: boolean) => void,
  ) => {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }

    console.warn(`[cors] Blocked origin: ${origin}`);
    callback(null, false);
  },
  credentials: true,
  optionsSuccessStatus: 204,
};

export const createApiApp = (
  options?: {
    connectDatabasePerRequest?: boolean;
  },
): Express => {
  const app = express();

  if (options?.connectDatabasePerRequest) {
    app.use(async (_request, _response, next) => {
      try {
        await connectDatabase();
        next();
      } catch (error) {
        next(error);
      }
    });
  }

  app.use(cors(corsOptions));
  app.options(/.*/, cors(corsOptions));
  app.use(express.json({ limit: '1mb' }));
  app.use(authenticationMiddleware);

  app.use('/api', apiRouter);
  app.use(errorMiddleware);

  return app;
};
