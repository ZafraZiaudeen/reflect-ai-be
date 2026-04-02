import { Router } from 'express';
import { couplesRouter } from './routes/couples.routes.js';
import { dashboardRouter } from './routes/dashboard.routes.js';
import { livekitRouter } from './routes/livekit.routes.js';
import { modelsRouter } from './routes/models.routes.js';
import { sessionsRouter } from './routes/sessions.routes.js';
export const apiRouter = Router();
apiRouter.get('/health', (_request, response) => {
    response.json({ ok: true });
});
apiRouter.use('/models', modelsRouter);
apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/couples', couplesRouter);
apiRouter.use('/sessions', sessionsRouter);
apiRouter.use('/livekit', livekitRouter);
