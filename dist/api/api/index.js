import { Router } from 'express';
import { env } from '../infrastructure/Config/env.js';
import { getHuggingFaceRuntimeStatus, getMongoRuntimeStatus, getVoiceWebSocketRuntimeStatus, } from '../infrastructure/Runtime/runtimeStatus.js';
import { couplesRouter } from './routes/couples.routes.js';
import { dashboardRouter } from './routes/dashboard.routes.js';
import { livekitRouter } from './routes/livekit.routes.js';
import { modelsRouter } from './routes/models.routes.js';
import { sessionsRouter } from './routes/sessions.routes.js';
export const apiRouter = Router();
apiRouter.get('/health', (_request, response) => {
    const mongo = getMongoRuntimeStatus();
    const huggingFace = getHuggingFaceRuntimeStatus();
    const voiceWs = getVoiceWebSocketRuntimeStatus();
    const huggingFaceStatus = huggingFace.lastEmbeddingFailureType || huggingFace.lastClassificationFailureType
        ? 'degraded'
        : env.HUGGINGFACE_API_KEY
            ? 'configured'
            : 'public-rate-limited';
    const services = {
        mongo,
        clerk: env.CLERK_SECRET_KEY && env.CLERK_PUBLISHABLE_KEY ? 'configured' : 'missing',
        deepgram: env.DEEPGRAM_API_KEY ? 'configured' : 'missing',
        openrouter: env.OPENROUTER_API_KEY ? 'configured' : 'missing',
        huggingFace: huggingFaceStatus,
    };
    response.json({
        ok: mongo === 'ready' && voiceWs.attached,
        mode: env.NODE_ENV,
        services,
        embeddingMode: huggingFace.embeddingMode,
        wsAttached: voiceWs.attached,
        runtime: {
            voiceAttachedAt: voiceWs.attachedAt,
            huggingFaceLastUpdatedAt: huggingFace.lastUpdatedAt,
            huggingFaceLastEmbeddingProvider: huggingFace.lastEmbeddingProvider,
            huggingFaceLastEmbeddingFailureType: huggingFace.lastEmbeddingFailureType,
            huggingFaceLastClassificationFailureType: huggingFace.lastClassificationFailureType,
        },
    });
});
apiRouter.use('/models', modelsRouter);
apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/couples', couplesRouter);
apiRouter.use('/sessions', sessionsRouter);
apiRouter.use('/livekit', livekitRouter);
