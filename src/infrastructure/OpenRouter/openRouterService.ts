import { LLM } from '@livekit/agents-plugin-openai';
import OpenAI from 'openai';
import { normalizeTruthReport } from '../../domain/Rules/sessionRules.js';
import { getModelAttemptOrder, type InterventionEvent, type TranscriptSegment, type TruthReport } from '../../domain/Types/mirror.js';
import { env } from '../Config/env.js';

const LIVE_SESSION_MAX_COMPLETION_TOKENS = 384;
const REPORT_MAX_COMPLETION_TOKENS = 2048;

const normalizeTokenBudget = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.min(Math.floor(value), fallback));
};

const capChatCompletionBudget = <T extends Record<string, unknown>>(payload: T, fallback: number): T => {
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

const extractJsonPayload = (content: unknown): Partial<TruthReport> => {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    const directParse = trimmed.startsWith('{') ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
    return directParse ? (JSON.parse(directParse) as Partial<TruthReport>) : {};
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((entry) => (typeof entry === 'object' && entry && 'text' in entry ? String((entry as { text: unknown }).text) : ''))
      .join('\n');
    return extractJsonPayload(joined);
  }

  return {};
};

export const createOpenRouterClient = (options?: { defaultMaxTokens?: number }): OpenAI => {
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
    const chatCompletions = client.chat.completions as typeof client.chat.completions & {
      create: typeof client.chat.completions.create;
    };
    const originalCreate = chatCompletions.create.bind(chatCompletions);

    chatCompletions.create = ((body: unknown, requestOptions?: unknown) =>
      originalCreate(
        capChatCompletionBudget((body ?? {}) as Record<string, unknown>, defaultMaxTokens) as never,
        requestOptions as never,
      )) as typeof chatCompletions.create;
  }

  return client;
};

export const createOpenRouterLlm = (modelId: string, temperature = 0.45): LLM =>
  new LLM({
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

export const generateTruthReport = async ({
  selectedModel,
  transcriptSegments,
  interventions,
  previousSummary,
}: {
  selectedModel: string;
  transcriptSegments: TranscriptSegment[];
  interventions: InterventionEvent[];
  previousSummary: string;
}): Promise<TruthReport> => {
  if (!env.OPENROUTER_API_KEY) {
    return normalizeTruthReport({}, transcriptSegments, interventions, previousSummary);
  }

  const client = createOpenRouterClient({
    defaultMaxTokens: REPORT_MAX_COMPLETION_TOKENS,
  });

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
            content:
              'You generate direct but professional couples-session truth reports. Avoid abuse, diagnosis, or threats. Return only valid JSON.',
          },
          {
            role: 'user',
            content: JSON.stringify(
              {
                previousSummary,
                interventions,
                transcriptSegments: transcriptSegments.map((segment) => ({
                  speakerRole: segment.speakerRole,
                  speakerLabel: segment.speakerLabel,
                  text: segment.text,
                  createdAt: segment.createdAt,
                  source: segment.source,
                })),
              },
              null,
              2,
            ),
          },
        ],
      } as never)) as {
        choices?: Array<{
          message?: {
            content?: unknown;
          };
        }>;
      };

      return normalizeTruthReport(
        extractJsonPayload(payload.choices?.[0]?.message?.content),
        transcriptSegments,
        interventions,
        previousSummary,
      );
    } catch {
      continue;
    }
  }

  return normalizeTruthReport({}, transcriptSegments, interventions, previousSummary);
};
