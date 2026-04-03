import { createHash } from 'node:crypto';
import { InferenceClient } from '@huggingface/inference';
import { env } from '../Config/env.js';
import { recordClassificationRuntime, recordEmbeddingRuntime, } from '../Runtime/runtimeStatus.js';
/* ------------------------------------------------------------------ */
/*  Models                                                              */
/* ------------------------------------------------------------------ */
const EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
const CLASSIFICATION_MODEL = 'facebook/bart-large-mnli';
export const EMBEDDING_DIMENSIONS = 384;
/* ------------------------------------------------------------------ */
/*  HuggingFace client singleton                                       */
/* ------------------------------------------------------------------ */
let hfClient = null;
const getHfClient = () => {
    if (!hfClient) {
        hfClient = new InferenceClient(env.HUGGINGFACE_API_KEY || undefined);
    }
    return hfClient;
};
const normalizeText = (text) => text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
const zeroVector = () => new Array(EMBEDDING_DIMENSIONS).fill(0);
const normalizeVectorLength = (vector) => {
    if (vector.length === EMBEDDING_DIMENSIONS) {
        return vector;
    }
    if (vector.length > EMBEDDING_DIMENSIONS) {
        return vector.slice(0, EMBEDDING_DIMENSIONS);
    }
    return [...vector, ...new Array(EMBEDDING_DIMENSIONS - vector.length).fill(0)];
};
const l2Normalize = (vector) => {
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!magnitude) {
        return vector;
    }
    return vector.map((value) => Number((value / magnitude).toFixed(8)));
};
const hashToUnsignedInt = (value) => createHash('sha256')
    .update(value)
    .digest()
    .readUInt32BE(0);
const buildLocalEmbedding = (text) => {
    const normalized = normalizeText(text);
    if (!normalized) {
        return zeroVector();
    }
    const vector = zeroVector();
    const tokens = normalized.split(' ').filter(Boolean);
    const trigrams = [];
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
const extractStatusCode = (error) => {
    if (!error || typeof error !== 'object') {
        return null;
    }
    const candidate = error.status ??
        error.response?.status;
    return typeof candidate === 'number' ? candidate : null;
};
const classifyHfFailure = (error) => {
    const status = extractStatusCode(error);
    const rawMessage = error instanceof Error ? error.message : String(error ?? 'Unknown Hugging Face error');
    const message = rawMessage.trim();
    const lower = message.toLowerCase();
    if (status === 401 ||
        status === 403 ||
        lower.includes('unauthorized') ||
        lower.includes('forbidden') ||
        lower.includes('invalid token') ||
        lower.includes('api key')) {
        return { type: 'auth', message };
    }
    if (status === 400 ||
        status === 404 ||
        status === 422 ||
        lower.includes('provider') ||
        lower.includes('endpoint') ||
        lower.includes('model') ||
        lower.includes('route')) {
        return { type: 'provider', message };
    }
    if (status === 408 ||
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
        lower.includes('service unavailable')) {
        return { type: 'transient', message };
    }
    return { type: 'unknown', message };
};
const normalizeFeatureExtractionOutput = (result) => {
    if (!Array.isArray(result) || result.length === 0) {
        return null;
    }
    if (typeof result[0] === 'number') {
        return normalizeVectorLength(result);
    }
    if (Array.isArray(result[0]) && typeof result[0][0] === 'number') {
        return normalizeVectorLength(result[0]);
    }
    return null;
};
/* ------------------------------------------------------------------ */
/*  Embedding generation                                                */
/* ------------------------------------------------------------------ */
export const generateEmbedding = async (text) => {
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
    }
    catch (error) {
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
/*  Honesty analysis via zero-shot classification                      */
/*                                                                      */
/*  Uses HuggingFace free inference API (facebook/bart-large-mnli)     */
/*  to classify utterances into honesty-related categories.            */
/* ------------------------------------------------------------------ */
const HONESTY_LABELS = [
    'taking accountability and being honest',
    'genuine engagement and vulnerability',
    'defensive and deflecting blame',
    'contemptuous or dismissive',
    'denying responsibility',
    'stonewalling or withdrawing',
];
const HONESTY_WEIGHTS = {
    'taking accountability and being honest': 35,
    'genuine engagement and vulnerability': 25,
    'defensive and deflecting blame': -25,
    'contemptuous or dismissive': -35,
    'denying responsibility': -30,
    'stonewalling or withdrawing': -20,
};
/**
 * Analyze a single utterance for honesty indicators.
 * Returns a score from 1-100 and the dominant label.
 */
export const analyzeHonesty = async (text) => {
    const trimmed = text.trim();
    if (!trimmed || trimmed.split(/\s+/).length < 3) {
        return { score: 50, label: 'unknown', confidence: 0, breakdown: {} };
    }
    try {
        const client = getHfClient();
        const result = await client.zeroShotClassification({
            accessToken: env.HUGGINGFACE_API_KEY || undefined,
            model: CLASSIFICATION_MODEL,
            endpointUrl: env.HUGGINGFACE_CLASSIFICATION_ENDPOINT || undefined,
            provider: 'hf-inference',
            inputs: trimmed,
            parameters: { candidate_labels: HONESTY_LABELS },
        });
        // Handle the response — may be a single result or an array
        const rawClassification = Array.isArray(result) ? result[0] : result;
        const classification = rawClassification;
        const labels = classification?.labels;
        const scores = classification?.scores;
        if (!labels || !scores || labels.length === 0) {
            return { score: 50, label: 'unknown', confidence: 0, breakdown: {} };
        }
        // Build score from weighted combination of all labels
        const breakdown = {};
        let weightedSum = 0;
        for (let i = 0; i < labels.length; i++) {
            const label = labels[i];
            const probability = scores[i] ?? 0;
            breakdown[label] = probability;
            weightedSum += probability * (HONESTY_WEIGHTS[label] ?? 0);
        }
        // Center around 50, then clamp to [1, 100]
        const score = Math.max(1, Math.min(100, Math.round(50 + weightedSum)));
        return {
            score,
            label: labels[0] || 'unknown',
            confidence: scores[0] || 0,
            breakdown,
        };
    }
    catch (error) {
        const failure = classifyHfFailure(error);
        console.warn(`[honesty] Hugging Face zero-shot classification failed (${failure.type}). Using neutral fallback score.`, error);
        recordClassificationRuntime({
            failureType: failure.type,
            failureMessage: failure.message,
        });
        return { score: 50, label: 'unknown', confidence: 0, breakdown: {} };
    }
};
/**
 * Analyze a batch of utterances and return an aggregate honesty score.
 * Used at session end for the final validated score.
 */
export const analyzeSessionHonesty = async (utterances) => {
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
    const speakerScores = {};
    // Analyze in small batches to respect rate limits
    for (const utterance of sampled) {
        const result = await analyzeHonesty(utterance.text);
        if (!speakerScores[utterance.speaker]) {
            speakerScores[utterance.speaker] = [];
        }
        speakerScores[utterance.speaker].push(result.score);
        // Brief delay between requests to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // Compute per-speaker averages
    const perSpeaker = {};
    const allScores = [];
    for (const [speaker, scores] of Object.entries(speakerScores)) {
        const avg = Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length);
        perSpeaker[speaker] = avg;
        allScores.push(avg);
    }
    // Overall score is the average across speakers
    const score = allScores.length > 0
        ? Math.round(allScores.reduce((sum, s) => sum + s, 0) / allScores.length)
        : 50;
    return { score: Math.max(1, Math.min(100, score)), perSpeaker };
};
/* ------------------------------------------------------------------ */
/*  Cosine similarity (for fallback vector search without Atlas)       */
/* ------------------------------------------------------------------ */
export const cosineSimilarity = (a, b) => {
    if (a.length !== b.length || a.length === 0)
        return 0;
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
