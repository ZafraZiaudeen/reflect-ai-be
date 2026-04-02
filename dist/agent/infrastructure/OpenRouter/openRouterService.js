import { LLM } from '@livekit/agents-plugin-openai';
import OpenAI from 'openai';
import { normalizeTruthReport } from '../../domain/Rules/sessionRules.js';
import { getModelAttemptOrder } from '../../domain/Types/mirror.js';
import { env } from '../Config/env.js';
const LIVE_SESSION_MAX_COMPLETION_TOKENS = 384;
const REPORT_MAX_COMPLETION_TOKENS = 2048;
const normalizeTokenBudget = (value, fallback) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(1, Math.min(Math.floor(value), fallback));
};
const capChatCompletionBudget = (payload, fallback) => {
    const maxTokens = normalizeTokenBudget(payload.max_tokens ?? payload.max_completion_tokens, fallback);
    return {
        ...payload,
        max_tokens: maxTokens,
        max_completion_tokens: maxTokens,
    };
};
const reportSchema = {
    type: 'object',
    properties: {
        coreConflict: { type: 'string' },
        truthSummary: { type: 'string' },
        observedPatterns: { type: 'array', items: { type: 'string' } },
        homework: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    title: { type: 'string' },
                    description: { type: 'string' },
                    reflectionPrompt: { type: 'string' },
                },
                required: ['title', 'description', 'reflectionPrompt'],
            },
        },
        nextGoal: { type: 'string' },
        honestyScore: { type: 'number' },
        clinicalFrame: { type: 'string' },
    },
    required: [
        'coreConflict',
        'truthSummary',
        'observedPatterns',
        'homework',
        'nextGoal',
        'honestyScore',
        'clinicalFrame',
    ],
};
const extractJsonPayload = (content) => {
    if (typeof content === 'string') {
        const trimmed = content.trim();
        const directParse = trimmed.startsWith('{') ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
        return directParse ? JSON.parse(directParse) : {};
    }
    if (Array.isArray(content)) {
        const joined = content
            .map((entry) => (typeof entry === 'object' && entry && 'text' in entry ? String(entry.text) : ''))
            .join('\n');
        return extractJsonPayload(joined);
    }
    return {};
};
export const createOpenRouterClient = (options) => {
    const client = new OpenAI({
        apiKey: env.OPENROUTER_API_KEY,
        baseURL: env.OPENROUTER_BASE_URL,
        defaultHeaders: {
            'HTTP-Referer': env.OPENROUTER_HTTP_REFERER,
            'X-Title': env.OPENROUTER_APP_NAME,
        },
    });
    if (options?.defaultMaxTokens) {
        const defaultMaxTokens = options.defaultMaxTokens;
        const chatCompletions = client.chat.completions;
        const originalCreate = chatCompletions.create.bind(chatCompletions);
        chatCompletions.create = ((body, requestOptions) => originalCreate(capChatCompletionBudget((body ?? {}), defaultMaxTokens), requestOptions));
    }
    return client;
};
export const createOpenRouterLlm = (modelId, temperature = 0.45) => new LLM({
    model: modelId,
    client: createOpenRouterClient({
        defaultMaxTokens: LIVE_SESSION_MAX_COMPLETION_TOKENS,
    }),
    temperature,
    maxCompletionTokens: LIVE_SESSION_MAX_COMPLETION_TOKENS,
    metadata: {
        app: env.OPENROUTER_APP_NAME,
    },
});
export const generateTruthReport = async ({ selectedModel, transcriptSegments, interventions, previousSummary, reflectionHistory, }) => {
    if (!env.OPENROUTER_API_KEY) {
        return normalizeTruthReport({}, transcriptSegments, interventions, previousSummary);
    }
    const client = createOpenRouterClient({
        defaultMaxTokens: REPORT_MAX_COMPLETION_TOKENS,
    });
    const systemPrompt = [
        'You generate direct but professional couples-session truth reports.',
        'Analyze the transcript for Gottman Four Horsemen patterns (Criticism, Contempt, Defensiveness, Stonewalling).',
        'Score honesty from 1-100 based on accountability, denial, deflection, and genuine engagement observed.',
        '',
        'CRITICAL — DYNAMIC HOMEWORK GENERATION:',
        'The "homework" array MUST contain 2 assignments with reflection prompts that are SPECIFIC to what happened in THIS session.',
        'Do NOT use generic prompts. Reference specific moments, quotes, patterns, or conflicts from the transcript.',
        'Each reflectionPrompt should ask the partner to reflect on something SPECIFIC they said or did in this session.',
        'The prompts should build on previous sessions and push for deeper accountability and progress.',
        'Example good prompt: "You said \'I never ignore you\' but your partner described three specific incidents. Write about why you minimized those moments."',
        'Example bad prompt: "What part of this conflict are you still minimizing?" (too generic)',
        '',
        'If reflection history from previous sessions is provided, reference patterns of growth or stagnation.',
        'The homework should feel like a natural continuation of the conversation, not a worksheet.',
        '',
        'Avoid abuse, diagnosis, or threats. Return only valid JSON.',
    ].join('\n');
    const userPayload = {
        previousSummary,
        interventions,
        transcriptSegments: transcriptSegments.map((segment) => ({
            speakerRole: segment.speakerRole,
            speakerLabel: segment.speakerLabel,
            text: segment.text,
            createdAt: segment.createdAt,
            source: segment.source,
        })),
    };
    if (reflectionHistory) {
        userPayload.reflectionHistory = reflectionHistory;
    }
    for (const model of getModelAttemptOrder(selectedModel, { preferReportModel: true })) {
        try {
            const payload = (await client.chat.completions.create({
                model: model.id,
                temperature: 0.25,
                max_tokens: REPORT_MAX_COMPLETION_TOKENS,
                max_completion_tokens: REPORT_MAX_COMPLETION_TOKENS,
                response_format: {
                    type: 'json_schema',
                    json_schema: {
                        name: 'truth_report',
                        schema: reportSchema,
                    },
                },
                messages: [
                    {
                        role: 'system',
                        content: systemPrompt,
                    },
                    {
                        role: 'user',
                        content: JSON.stringify(userPayload, null, 2),
                    },
                ],
            }));
            return normalizeTruthReport(extractJsonPayload(payload.choices?.[0]?.message?.content), transcriptSegments, interventions, previousSummary);
        }
        catch {
            continue;
        }
    }
    return normalizeTruthReport({}, transcriptSegments, interventions, previousSummary);
};
