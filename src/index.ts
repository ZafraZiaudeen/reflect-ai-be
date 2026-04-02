import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { apiRouter } from './api/index.js';
import { authenticationMiddleware } from './infrastructure/Auth/authentication.js';
import { env } from './infrastructure/Config/env.js';
import { connectDatabase } from './infrastructure/Database/connectDatabase.js';
import { errorMiddleware } from './infrastructure/Http/errorMiddleware.js';
import { attachVoiceWebSocket } from './infrastructure/Voice/voiceWebSocket.js';

process.on('unhandledRejection', (reason, promise) => {
  console.error('[process] Unhandled promise rejection caught — keeping process alive.', reason);
});

const startServer = async (): Promise<void> => {
  await connectDatabase();

  const allowedOrigins = Array.from(
    new Set(
      [
        ...env.CLIENT_URL.split(',').map((origin) => origin.trim()),
        'http://localhost:5173',
      ].filter(Boolean),
    ),
  );

  const app = express();
  app.use(
    cors({
      origin: (
        origin: string | undefined,
        callback: (error: Error | null, allow?: boolean) => void,
      ) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error(`CORS blocked for origin: ${origin}`));
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(authenticationMiddleware);

  app.use('/api', apiRouter);
  app.use(errorMiddleware);

  const httpServer = createServer(app);

  attachVoiceWebSocket(httpServer);

  httpServer.listen(env.PORT, () => {
    console.log(`Project Mirror API listening on port ${env.PORT}`);
  });
};

void startServer();
