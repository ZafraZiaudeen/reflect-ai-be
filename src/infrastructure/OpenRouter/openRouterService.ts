import { LLM } from '@livekit/agents-plugin-openai';
import OpenAI from 'openai';
import {
  buildHomeworkAttributionGuidance,
  normalizeTruthReport,
} from '../../domain/Rules/sessionRules.js';
import {
  getModelAttemptOrder,
  type InterventionEvent,
  type TranscriptSegment,
  type TruthReport,
} from '../../domain/Types/mirror.js';
import { env } from '../Config/env.js';

const LIVE_SESSION_MAX_COMPLETION_TOKENS = 384;
const REPORT_MAX_COMPLETION_TOKENS = 2048;

const normalizeTokenBudget = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.min(Math.floor(value), fallback));
};

const capChatCompletionBudget = <T extends Record<string, unknown>>(
  payload: T,
  fallback: number,
): T => {
  const maxTokens = normalizeTokenBudget(
    payload.max_tokens ?? payload.max_completion_tokens,
    fallback,
  );

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
          targetPartnerRole: {
            type: 'string',
            enum: ['partner_a', 'partner_b'],
          },
        },
        required: ['title', 'description', 'reflectionPrompt', 'targetPartnerRole'],
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
    const directParse = trimmed.startsWith('{')
      ? trimmed
      : trimmed.match(/\{[\s\S]*\}/)?.[0];
    return directParse ? (JSON.parse(directParse) as Partial<TruthReport>) : {};
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((entry) =>
        typeof entry === 'object' && entry && 'text' in entry
          ? String((entry as { text: unknown }).text)
          : '',
      )
      .join('\n');
    return extractJsonPayload(joined);
  }

  return {};
};

export const createOpenRouterClient = (options?: {
  defaultMaxTokens?: number;
}): OpenAI => {
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
        capChatCompletionBudget(
          (body ?? {}) as Record<string, unknown>,
          defaultMaxTokens,
        ) as never,
        requestOptions as never,
      )) as typeof chatCompletions.create;
  }

  return client;
};

export const createOpenRouterLlm = (
  modelId: string,
  temperature = 0.45,
): LLM =>
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
  reflectionHistory,
}: {
  selectedModel: string;
  transcriptSegments: TranscriptSegment[];
  interventions: InterventionEvent[];
  previousSummary: string;
  reflectionHistory?: string;
}): Promise<TruthReport> => {
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
    'CRITICAL - DYNAMIC HOMEWORK GENERATION:',
    'The "homework" array MUST contain exactly 2 assignments.',
    'One assignment MUST have targetPartnerRole "partner_a" and the other MUST have targetPartnerRole "partner_b".',
    'Do NOT use generic prompts. Reference specific moments, quotes, patterns, or conflicts from the transcript.',
    'Each reflectionPrompt should ask that specific partner to reflect on something SPECIFIC they said or did in this session.',
    'Each prompt must be anchored to that same partner\'s own speech or self-attributed behavior, not to something only their partner accused them of.',
    'Never assign partner_a a prompt derived from partner_b\'s quote, and never assign partner_b a prompt derived from partner_a\'s quote.',
    'If a partner spoke very little, use the limited speaker evidence provided for that role or return a role-correct fallback prompt instead of borrowing the other partner\'s quote.',
    'The prompts should build on previous sessions and push for deeper accountability and progress.',
    'Example good prompt: "You said \'I never ignore you\' but your partner described three specific incidents. Write about why you minimized those moments."',
    'Example bad prompt: "What part of this conflict are you still minimizing?" (too generic)',
    '',
    'If reflection history from previous sessions is provided, reference patterns of growth or stagnation.',
    'The homework should feel like a natural continuation of the conversation, not a worksheet.',
    '',
    'Avoid abuse, diagnosis, or threats. Return only valid JSON.',
  ].join('\n');

  const userPayload: Record<string, unknown> = {
    previousSummary,
    interventions,
    homeworkTargeting: buildHomeworkAttributionGuidance(transcriptSegments),
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

export const generateCumulativeSummary = async ({
  existingSummary,
  newSession,
  selectedModel,
}: {
  existingSummary: string;
  newSession: {
    coreConflict: string;
    truthSummary: string;
    observedPatterns: string[];
    nextGoal: string;
    homeworkTitles: string[];
  };
  selectedModel: string;
}): Promise<string> => {
  if (!env.OPENROUTER_API_KEY) {
    return buildFallbackCumulativeSummary(existingSummary, newSession);
  }

  const client = createOpenRouterClient({ defaultMaxTokens: 400 });

  const systemPrompt = [
    'You maintain a concise running memory for a couples therapy program.',
    'You will receive the existing memory and new information from the session that just ended.',
    'Output ONLY a single updated memory paragraph (2-4 sentences, max 280 words).',
    'This memory will be read aloud by the therapist AI at the start of the next session.',
    'Write in plain spoken prose. No bullet points, no headers, no markdown.',
    'Capture: the recurring core conflict, any meaningful shifts or breakthroughs, patterns still unresolved,',
    'and the homework assigned. Fold the new session into the existing narrative — do not repeat history,',
    'just update it.',
  ].join(' ');

  const userContent = [
    existingSummary
      ? `Existing memory:\n${existingSummary}`
      : 'This is the first session. There is no prior memory.',
    '',
    'New session:',
    `Core conflict: ${newSession.coreConflict}`,
    `What emerged: ${newSession.truthSummary}`,
    `Patterns observed: ${newSession.observedPatterns.join(', ') || 'none named'}`,
    `Goal for next session: ${newSession.nextGoal}`,
    `Homework assigned: ${newSession.homeworkTitles.join(' | ') || 'none'}`,
  ].join('\n');

  for (const model of getModelAttemptOrder(selectedModel, { preferReportModel: true })) {
    try {
      const response = await client.chat.completions.create({
        model: model.id,
        temperature: 0.3,
        max_tokens: 400,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      } as never) as { choices?: Array<{ message?: { content?: string } }> };

      const text = response.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch {
      continue;
    }
  }

  return buildFallbackCumulativeSummary(existingSummary, newSession);
};

const buildFallbackCumulativeSummary = (
  existingSummary: string,
  newSession: { coreConflict: string; truthSummary: string; nextGoal: string; homeworkTitles: string[] },
): string => {
  const parts: string[] = [];
  if (existingSummary) parts.push(existingSummary);
  parts.push(
    `In the most recent session, the core conflict was: ${newSession.coreConflict}. ${newSession.truthSummary} The goal for the next session is: ${newSession.nextGoal}.`,
  );
  if (newSession.homeworkTitles.length > 0) {
    parts.push(`Homework assigned: ${newSession.homeworkTitles.join(', ')}.`);
  }
  return parts.join(' ');
};
