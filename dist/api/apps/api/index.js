import { createServer } from 'node:http';
import { createApiApp } from './app.js';
import { env } from '../../infrastructure/Config/env.js';
import { connectDatabase } from '../../infrastructure/Database/connectDatabase.js';
import { attachVoiceWebSocket } from '../../infrastructure/Voice/voiceWebSocket.js';
process.on('unhandledRejection', (reason, promise) => {
    console.error('[process] Unhandled promise rejection caught - keeping process alive.', reason);
});
const startServer = async () => {
    await connectDatabase();
    const app = createApiApp();
    const httpServer = createServer(app);
    attachVoiceWebSocket(httpServer);
    httpServer.listen(env.PORT, () => {
        console.log(`Project Mirror API listening on port ${env.PORT}`);
    });
};
void startServer();
