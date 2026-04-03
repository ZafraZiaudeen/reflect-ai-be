import mongoose from 'mongoose';
import { env } from '../Config/env.js';
const huggingFaceRuntimeState = {
    embeddingMode: env.HUGGINGFACE_API_KEY ? 'huggingface' : 'local-fallback',
    lastEmbeddingProvider: env.HUGGINGFACE_API_KEY ? 'huggingface' : 'local-hash',
    lastEmbeddingFailureType: null,
    lastEmbeddingFailureMessage: null,
    lastClassificationFailureType: null,
    lastClassificationFailureMessage: null,
    lastUpdatedAt: null,
};
const voiceWebSocketRuntimeState = {
    attached: false,
    attachedAt: null,
};
const touchRuntimeState = () => new Date().toISOString();
export const recordEmbeddingRuntime = (args) => {
    huggingFaceRuntimeState.embeddingMode = args.embeddingMode;
    huggingFaceRuntimeState.lastEmbeddingProvider = args.provider;
    huggingFaceRuntimeState.lastEmbeddingFailureType = args.failureType ?? null;
    huggingFaceRuntimeState.lastEmbeddingFailureMessage = args.failureMessage ?? null;
    huggingFaceRuntimeState.lastUpdatedAt = touchRuntimeState();
};
export const recordClassificationRuntime = (args) => {
    huggingFaceRuntimeState.lastClassificationFailureType = args.failureType ?? null;
    huggingFaceRuntimeState.lastClassificationFailureMessage = args.failureMessage ?? null;
    huggingFaceRuntimeState.lastUpdatedAt = touchRuntimeState();
};
export const getHuggingFaceRuntimeStatus = () => ({
    ...huggingFaceRuntimeState,
});
export const markVoiceWebSocketAttached = () => {
    voiceWebSocketRuntimeState.attached = true;
    voiceWebSocketRuntimeState.attachedAt = touchRuntimeState();
};
export const getVoiceWebSocketRuntimeStatus = () => ({
    ...voiceWebSocketRuntimeState,
});
export const getMongoRuntimeStatus = () => {
    if (!env.MONGODB_URL) {
        return 'missing';
    }
    switch (mongoose.connection.readyState) {
        case 1:
            return 'ready';
        case 2:
            return 'connecting';
        case 3:
            return 'disconnecting';
        default:
            return 'disconnected';
    }
};
