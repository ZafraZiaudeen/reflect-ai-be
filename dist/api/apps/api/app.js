import cors from 'cors';
import express from 'express';
import { apiRouter } from '../../api/index.js';
import { authenticationMiddleware } from '../../infrastructure/Auth/authentication.js';
import { env } from '../../infrastructure/Config/env.js';
import { connectDatabase } from '../../infrastructure/Database/connectDatabase.js';
import { errorMiddleware } from '../../infrastructure/Http/errorMiddleware.js';
const allowedOrigins = Array.from(new Set([
    ...env.CLIENT_URL.split(',').map((origin) => origin.trim()),
    'http://localhost:5173',
].filter(Boolean)));
export const createApiApp = (options) => {
    const app = express();
    if (options?.connectDatabasePerRequest) {
        app.use(async (_request, _response, next) => {
            try {
                await connectDatabase();
                next();
            }
            catch (error) {
                next(error);
            }
        });
    }
    app.use(cors({
        origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) {
                callback(null, true);
                return;
            }
            callback(new Error(`CORS blocked for origin: ${origin}`));
        },
        credentials: true,
    }));
    app.use(express.json({ limit: '1mb' }));
    app.use(authenticationMiddleware);
    app.use('/api', apiRouter);
    app.use(errorMiddleware);
    return app;
};
