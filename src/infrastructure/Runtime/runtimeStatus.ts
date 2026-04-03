import mongoose from 'mongoose';
import { env } from '../Config/env.js';

export type HuggingFaceFailureType = 'auth' | 'provider' | 'transient' | 'unknown';
export type EmbeddingMode = 'huggingface' | 'hybrid' | 'local-fallback';

interface HuggingFaceRuntimeState {
  embeddingMode: EmbeddingMode;
  lastEmbeddingProvider: 'huggingface' | 'local-hash';
  lastEmbeddingFailureType: HuggingFaceFailureType | null;
  lastEmbeddingFailureMessage: string | null;
  lastClassificationFailureType: HuggingFaceFailureType | null;
  lastClassificationFailureMessage: string | null;
  lastUpdatedAt: string | null;
}

const huggingFaceRuntimeState: HuggingFaceRuntimeState = {
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
  attachedAt: null as string | null,
};

const touchRuntimeState = (): string => new Date().toISOString();

export const recordEmbeddingRuntime = (args: {
  embeddingMode: EmbeddingMode;
  provider: 'huggingface' | 'local-hash';
  failureType?: HuggingFaceFailureType | null;
  failureMessage?: string | null;
}): void => {
  huggingFaceRuntimeState.embeddingMode = args.embeddingMode;
  huggingFaceRuntimeState.lastEmbeddingProvider = args.provider;
  huggingFaceRuntimeState.lastEmbeddingFailureType = args.failureType ?? null;
  huggingFaceRuntimeState.lastEmbeddingFailureMessage = args.failureMessage ?? null;
  huggingFaceRuntimeState.lastUpdatedAt = touchRuntimeState();
};

export const recordClassificationRuntime = (args: {
  failureType?: HuggingFaceFailureType | null;
  failureMessage?: string | null;
}): void => {
  huggingFaceRuntimeState.lastClassificationFailureType = args.failureType ?? null;
  huggingFaceRuntimeState.lastClassificationFailureMessage = args.failureMessage ?? null;
  huggingFaceRuntimeState.lastUpdatedAt = touchRuntimeState();
};

export const getHuggingFaceRuntimeStatus = (): HuggingFaceRuntimeState => ({
  ...huggingFaceRuntimeState,
});

export const markVoiceWebSocketAttached = (): void => {
  voiceWebSocketRuntimeState.attached = true;
  voiceWebSocketRuntimeState.attachedAt = touchRuntimeState();
};

export const getVoiceWebSocketRuntimeStatus = (): { attached: boolean; attachedAt: string | null } => ({
  ...voiceWebSocketRuntimeState,
});

export const getMongoRuntimeStatus = (): 'missing' | 'disconnected' | 'connecting' | 'ready' | 'disconnecting' => {
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

