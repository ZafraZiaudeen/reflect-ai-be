import { HfInference } from '@huggingface/inference';
import { env } from '../Config/env.js';
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
        // Works without API key for public models (rate-limited).
        // With a free HuggingFace token, you get higher rate limits.
        hfClient = new HfInference(env.HUGGINGFACE_API_KEY || undefined);
    }
    return hfClient;
};
/* ------------------------------------------------------------------ */
/*  Embedding generation                                                */
/* ------------------------------------------------------------------ */
export const generateEmbedding = async (text) => {
    const trimmed = text.trim();
    if (!trimmed) {
        return new Array(EMBEDDING_DIMENSIONS).fill(0);
    }
    try {
        const client = getHfClient();
        const result = await client.featureExtraction({
            model: EMBEDDING_MODEL,
            inputs: trimmed.slice(0, 2048), // limit to ~2k chars to stay within model context
        });
        // sentence-transformers returns a flat array for a single input
        if (Array.isArray(result) && typeof result[0] === 'number') {
            return result;
        }
        // If nested (batch output), take the first
        if (Array.isArray(result) && Array.isArray(result[0])) {
            return result[0];
        }
        return new Array(EMBEDDING_DIMENSIONS).fill(0);
    }
    catch (error) {
        console.warn('[embedding] Failed to generate embedding, returning zero vector:', error);
        return new Array(EMBEDDING_DIMENSIONS).fill(0);
    }
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
            model: CLASSIFICATION_MODEL,
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
        console.warn('[honesty] HuggingFace analysis failed, returning neutral score:', error);
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
