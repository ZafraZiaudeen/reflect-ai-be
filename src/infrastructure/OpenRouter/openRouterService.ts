import { normalizeTruthReport } from '../../domain/Rules/sessionRules.js';
import type { InterventionEvent, TranscriptSegment, TruthReport } from '../../domain/Types/mirror.js';
import { env } from '../Config/env.js';

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

  try {
    const response = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': env.OPENROUTER_HTTP_REFERER,
        'X-Title': env.OPENROUTER_APP_NAME,
      },
      body: JSON.stringify({
        model: selectedModel,
        temperature: 0.35,
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
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter error: ${response.status}`);
    }

    const payload = (await response.json()) as {
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
    return normalizeTruthReport({}, transcriptSegments, interventions, previousSummary);
  }
};
