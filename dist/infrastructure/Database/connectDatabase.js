import mongoose from 'mongoose';
import { env, ensureEnvValue } from '../Config/env.js';
let connectionPromise = null;
const CONNECT_RETRY_DELAYS_MS = [0, 750, 1_500, 3_000];
const wait = async (durationMs) => new Promise((resolve) => {
    setTimeout(resolve, durationMs);
});
mongoose.connection.on('disconnected', () => {
    connectionPromise = null;
});
mongoose.connection.on('error', () => {
    if (mongoose.connection.readyState === 0) {
        connectionPromise = null;
    }
});
export const connectDatabase = async (options) => {
    if (mongoose.connection.readyState === 1) {
        return mongoose;
    }
    if (!connectionPromise) {
        connectionPromise = (async () => {
            const maxAttempts = Math.max(1, (options?.retries ?? 3) + 1);
            for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
                try {
                    return await mongoose.connect(ensureEnvValue(env.MONGODB_URL, 'MONGODB_URL'), {
                        serverSelectionTimeoutMS: 5_000,
                        socketTimeoutMS: 20_000,
                        maxPoolSize: 10,
                    });
                }
                catch (error) {
                    if (attempt === maxAttempts - 1) {
                        throw error;
                    }
                    const delayMs = CONNECT_RETRY_DELAYS_MS[Math.min(attempt + 1, CONNECT_RETRY_DELAYS_MS.length - 1)] ?? 1_500;
                    await wait(delayMs);
                }
            }
            throw new Error('Database connection retry loop exited unexpectedly.');
        })().catch((error) => {
            connectionPromise = null;
            throw error;
        });
    }
    return connectionPromise;
};
