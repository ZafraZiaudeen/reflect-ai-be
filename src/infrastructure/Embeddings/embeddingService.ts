import { createHash } from 'node:crypto';
import { InferenceClient } from '@huggingface/inference';
import { env } from '../Config/env.js';
import {
  recordClassificationRuntime,
  recordEmbeddingRuntime,
  type HuggingFaceFailureType,
} from '../Runtime/runtimeStatus.js';
import { createOpenRouterClient } from '../OpenRouter/openRouterService.js';

/* ------------------------------------------------------------------ */
/*  Models                                                              */
/* ------------------------------------------------------------------ */

const EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSIONS = 384;

/* ------------------------------------------------------------------ */
/*  HuggingFace client singleton                                       */
/* ------------------------------------------------------------------ */

let hfClient: InferenceClient | null = null;

const getHfClient = (): InferenceClient => {
  if (!hfClient) {
    hfClient = new InferenceClient(env.HUGGINGFACE_API_KEY || undefined);
  }
  return hfClient;
};

export interface EmbeddingResult {
  vector: number[];
  provider: 'huggingface' | 'local-hash';
  fallbackUsed: boolean;
  failureType: HuggingFaceFailureType | null;
}

const normalizeText = (text: string): string =>
  text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const zeroVector = (): number[] => new Array(EMBEDDING_DIMENSIONS).fill(0);

const normalizeVectorLength = (vector: number[]): number[] => {
  if (vector.length === EMBEDDING_DIMENSIONS) {
    return vector;
  }

  if (vector.length > EMBEDDING_DIMENSIONS) {
    return vector.slice(0, EMBEDDING_DIMENSIONS);
  }

  return [...vector, ...new Array(EMBEDDING_DIMENSIONS - vector.length).fill(0)];
};

const l2Normalize = (vector: number[]): number[] => {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) {
    return vector;
  }

  return vector.map((value) => Number((value / magnitude).toFixed(8)));
};

const hashToUnsignedInt = (value: string): number =>
  createHash('sha256')
    .update(value)
    .digest()
    .readUInt32BE(0);

const buildLocalEmbedding = (text: string): number[] => {
  const normalized = normalizeText(text);
  if (!normalized) {
    return zeroVector();
  }

  const vector = zeroVector();
  const tokens = normalized.split(' ').filter(Boolean);
  const trigrams: string[] = [];

  for (let i = 0; i < normalized.length - 2; i += 1) {
    trigrams.push(normalized.slice(i, i + 3));
  }

  const features = [
    ...tokens.map((token, index) => ({ value: `tok:${index}:${token}`, weight: 1 + Math.log1p(token.length) })),
    ...trigrams.map((gram) => ({ value: `tri:${gram}`, weight: 0.35 })),
  ];

  for (const feature of features) {
    for (let seed = 0; seed < 3; seed += 1) {
      const hash = hashToUnsignedInt(`${seed}:${feature.value}`);
      const dimension = hash % EMBEDDING_DIMENSIONS;
      const sign = (hash & 1) === 0 ? 1 : -1;
      vector[dimension] += sign * feature.weight;
    }
  }

  return l2Normalize(vector);
};

const extractStatusCode = (error: unknown): number | null => {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const candidate = (error as { status?: unknown; response?: { status?: unknown } }).status ??
    (error as { response?: { status?: unknown } }).response?.status;

  return typeof candidate === 'number' ? candidate : null;
};

const classifyHfFailure = (error: unknown): { type: HuggingFaceFailureType; message: string } => {
  const status = extractStatusCode(error);
  const rawMessage = error instanceof Error ? error.message : String(error ?? 'Unknown Hugging Face error');
  const message = rawMessage.trim();
  const lower = message.toLowerCase();

  if (
    status === 401 ||
    status === 403 ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('invalid token') ||
    lower.includes('api key')
  ) {
    return { type: 'auth', message };
  }

  if (
    status === 400 ||
    status === 404 ||
    status === 422 ||
    lower.includes('provider') ||
    lower.includes('endpoint') ||
    lower.includes('model') ||
    lower.includes('route')
  ) {
    return { type: 'provider', message };
  }

  if (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    lower.includes('rate limit') ||
    lower.includes('timeout') ||
    lower.includes('temporar') ||
    lower.includes('overloaded') ||
    lower.includes('service unavailable')
  ) {
    return { type: 'transient', message };
  }

  return { type: 'unknown', message };
};

const normalizeFeatureExtractionOutput = (result: unknown): number[] | null => {
  if (!Array.isArray(result) || result.length === 0) {
    return null;
  }

  if (typeof result[0] === 'number') {
    return normalizeVectorLength(result as number[]);
  }

  if (Array.isArray(result[0]) && typeof result[0][0] === 'number') {
    return normalizeVectorLength(result[0] as number[]);
  }

  return null;
};

/* ------------------------------------------------------------------ */
/*  Embedding generation                                                */
/* ------------------------------------------------------------------ */

export const generateEmbedding = async (text: string): Promise<EmbeddingResult> => {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      vector: zeroVector(),
      provider: 'local-hash',
      fallbackUsed: false,
      failureType: null,
    };
  }

  try {
    const client = getHfClient();
    const result = await client.featureExtraction({
      accessToken: env.HUGGINGFACE_API_KEY || undefined,
      model: EMBEDDING_MODEL,
      endpointUrl: env.HUGGINGFACE_EMBEDDING_ENDPOINT || undefined,
      provider: 'hf-inference',
      encoding_format: 'float',
      dimensions: EMBEDDING_DIMENSIONS,
      inputs: trimmed.slice(0, 2048),
    });

    const normalized = normalizeFeatureExtractionOutput(result);
    if (normalized && normalized.some((value) => value !== 0)) {
      recordEmbeddingRuntime({
        embeddingMode: 'huggingface',
        provider: 'huggingface',
        failureType: null,
        failureMessage: null,
      });
      return {
        vector: l2Normalize(normalized),
        provider: 'huggingface',
        fallbackUsed: false,
        failureType: null,
      };
    }
  } catch (error) {
    const failure = classifyHfFailure(error);
    console.warn(`[embedding] Hugging Face embedding failed (${failure.type}). Falling back to local hash embedding.`, error);
    const localVector = buildLocalEmbedding(trimmed);
    recordEmbeddingRuntime({
      embeddingMode: env.HUGGINGFACE_API_KEY ? 'hybrid' : 'local-fallback',
      provider: 'local-hash',
      failureType: failure.type,
      failureMessage: failure.message,
    });
    return {
      vector: localVector,
      provider: 'local-hash',
      fallbackUsed: true,
      failureType: failure.type,
    };
  }

  const fallbackVector = buildLocalEmbedding(trimmed);
  recordEmbeddingRuntime({
    embeddingMode: env.HUGGINGFACE_API_KEY ? 'hybrid' : 'local-fallback',
    provider: 'local-hash',
    failureType: 'provider',
    failureMessage: 'Hugging Face returned an empty or unsupported embedding payload.',
  });
  return {
    vector: fallbackVector,
    provider: 'local-hash',
    fallbackUsed: true,
    failureType: 'provider',
  };
};

/* ------------------------------------------------------------------ */
/*  Honesty analysis via OpenRouter LLM classification                 */
/*                                                                      */
/*  Uses a fast OpenRouter model to classify utterances into            */
/*  honesty-related categories, replacing the unreliable HuggingFace   */
/*  free inference API.                                                 */
/* ------------------------------------------------------------------ */

const HONESTY_CLASSIFICATION_MODEL = 'google/gemini-2.5-flash';

const HONESTY_LABELS = [
  'taking accountability and being honest',
  'genuine engagement and vulnerability',
  'defensive and deflecting blame',
  'contemptuous or dismissive',
  'denying responsibility',
  'stonewalling or withdrawing',
] as const;

const HONESTY_WEIGHTS: Record<string, number> = {
  'taking accountability and being honest': 35,
  'genuine engagement and vulnerability': 25,
  'defensive and deflecting blame': -25,
  'contemptuous or dismissive': -35,
  'denying responsibility': -30,
  'stonewalling or withdrawing': -20,
};

export interface HonestyAnalysisResult {
  /** 1-100 score where higher = more honest and accountable */
  score: number;
  /** The dominant classification label */
  label: string;
  /** Confidence of the top label (0-1) */
  confidence: number;
  /** Full breakdown of label scores */
  breakdown: Record<string, number>;
}

const SINGLE_UTTERANCE_SYSTEM_PROMPT = [
  'You are a couples therapy utterance classifier.',
  'Given a single utterance from a therapy session, classify it against these labels by estimating the probability (0-1) that the utterance belongs to each category. Probabilities should sum to approximately 1.',
  '',
  'Labels:',
  ...HONESTY_LABELS.map((l) => `- ${l}`),
  '',
  'Respond with ONLY valid JSON in this exact format:',
  '{"labels":["label1","label2",...],"scores":[0.4,0.25,...]}',
  'Order labels from highest to lowest score.',
].join('\n');

const BATCH_SYSTEM_PROMPT = [
  'You are a couples therapy utterance classifier.',
  'Given a list of utterances from a therapy session (each with an index and speaker), classify each utterance against these labels by estimating the probability (0-1) that the utterance belongs to each category.',
  '',
  'Labels:',
  ...HONESTY_LABELS.map((l) => `- ${l}`),
  '',
  'Respond with ONLY valid JSON — an array of objects, one per utterance, in the same order:',
  '[{"index":0,"labels":["label1","label2",...],"scores":[0.4,0.25,...]},...]',
  'Within each object, order labels from highest to lowest score.',
].join('\n');

/**
 * Analyze a single utterance for honesty indicators.
 * Returns a score from 1-100 and the dominant label.
 */
export const analyzeHonesty = async (text: string): Promise<HonestyAnalysisResult> => {
  const trimmed = text.trim();
  if (!trimmed || trimmed.split(/\s+/).length < 3) {
    return { score: 50, label: 'unknown', confidence: 0, breakdown: {} };
  }

  if (!env.OPENROUTER_API_KEY) {
    return { score: 50, label: 'unknown', confidence: 0, breakdown: {} };
  }

  try {
    const client = createOpenRouterClient();
    const response = await client.chat.completions.create({
      model: HONESTY_CLASSIFICATION_MODEL,
      temperature: 0.1,
      max_tokens: 256,
      messages: [
        { role: 'system', content: SINGLE_UTTERANCE_SYSTEM_PROMPT },
        { role: 'user', content: trimmed },
      ],
    });

    const raw = response.choices?.[0]?.message?.content?.trim() ?? '';
    const jsonStr = raw.startsWith('{') ? raw : raw.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonStr) {
      return { score: 50, label: 'unknown', confidence: 0, breakdown: {} };
    }

    const parsed = JSON.parse(jsonStr) as { labels?: string[]; scores?: number[] };
    return computeHonestyScore(parsed.labels, parsed.scores);
  } catch (error) {
    console.warn('[honesty] OpenRouter classification failed. Using neutral fallback score.', error);
    recordClassificationRuntime({
      failureType: 'transient',
      failureMessage: error instanceof Error ? error.message : String(error),
    });
    return { score: 50, label: 'unknown', confidence: 0, breakdown: {} };
  }
};

/**
 * Compute honesty score from label probabilities.
 */
const computeHonestyScore = (
  labels?: string[],
  scores?: number[],
): HonestyAnalysisResult => {
  if (!labels || !scores || labels.length === 0) {
    return { score: 50, label: 'unknown', confidence: 0, breakdown: {} };
  }

  const breakdown: Record<string, number> = {};
  let weightedSum = 0;

  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]!;
    const probability = scores[i] ?? 0;
    breakdown[label] = probability;
    weightedSum += probability * (HONESTY_WEIGHTS[label] ?? 0);
  }

  const score = Math.max(1, Math.min(100, Math.round(50 + weightedSum)));

  return {
    score,
    label: labels[0] || 'unknown',
    confidence: scores[0] || 0,
    breakdown,
  };
};

/**
 * Analyze a batch of utterances and return an aggregate honesty score.
 * Uses a single LLM call for efficiency.
 * Used at session end for the final validated score.
 */
export const analyzeSessionHonesty = async (
  utterances: Array<{ speaker: string; text: string }>,
): Promise<{ score: number; perSpeaker: Record<string, number> }> => {
  if (utterances.length === 0) {
    return { score: 50, perSpeaker: {} };
  }

  // Sample up to 20 most relevant utterances (longer ones are more informative)
  const sampled = utterances
    .filter((u) => u.text.split(/\s+/).length >= 5)
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, 20);

  if (sampled.length === 0) {
    return { score: 50, perSpeaker: {} };
  }

  if (!env.OPENROUTER_API_KEY) {
    return { score: 50, perSpeaker: {} };
  }

  try {
    const client = createOpenRouterClient();
    const userContent = sampled
      .map((u, i) => `[${i}] ${u.speaker}: ${u.text}`)
      .join('\n');

    const response = await client.chat.completions.create({
      model: HONESTY_CLASSIFICATION_MODEL,
      temperature: 0.1,
      max_tokens: 2048,
      messages: [
        { role: 'system', content: BATCH_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    });

    const raw = response.choices?.[0]?.message?.content?.trim() ?? '';
    const jsonStr = raw.startsWith('[') ? raw : raw.match(/\[[\s\S]*\]/)?.[0];
    if (!jsonStr) {
      return { score: 50, perSpeaker: {} };
    }

    const parsed = JSON.parse(jsonStr) as Array<{
      index?: number;
      labels?: string[];
      scores?: number[];
    }>;

    const speakerScores: Record<string, number[]> = {};

    for (let i = 0; i < parsed.length; i++) {
      const entry = parsed[i]!;
      const idx = entry.index ?? i;
      const utterance = sampled[idx];
      if (!utterance) continue;

      const result = computeHonestyScore(entry.labels, entry.scores);
      if (!speakerScores[utterance.speaker]) {
        speakerScores[utterance.speaker] = [];
      }
      speakerScores[utterance.speaker].push(result.score);
    }

    // Compute per-speaker averages
    const perSpeaker: Record<string, number> = {};
    const allScores: number[] = [];

    for (const [speaker, scores] of Object.entries(speakerScores)) {
      const avg = Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length);
      perSpeaker[speaker] = avg;
      allScores.push(avg);
    }

    const score = allScores.length > 0
      ? Math.round(allScores.reduce((sum, s) => sum + s, 0) / allScores.length)
      : 50;

    return { score: Math.max(1, Math.min(100, score)), perSpeaker };
  } catch (error) {
    console.warn('[honesty] OpenRouter batch classification failed. Using neutral fallback.', error);
    return { score: 50, perSpeaker: {} };
  }
};

/* ------------------------------------------------------------------ */
/*  Cosine similarity (for fallback vector search without Atlas)       */
/* ------------------------------------------------------------------ */

export const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
};
