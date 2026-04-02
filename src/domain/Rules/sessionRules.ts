import { randomUUID } from 'node:crypto';
import type {
  HomeworkAssignment,
  HomeworkGate,
  InterventionEvent,
  SessionMetrics,
  TranscriptSegment,
  TruthReport,
} from '../Types/mirror.js';

const CONFLICT_KEYWORDS = [
  { label: 'financial transparency', words: ['money', 'debt', 'spending', 'budget', 'rent', 'bill'] },
  { label: 'trust and honesty', words: ['trust', 'lie', 'hid', 'truth', 'honest', 'secret'] },
  { label: 'emotional responsiveness', words: ['ignored', 'listen', 'heard', 'dismiss', 'cold'] },
  { label: 'division of effort', words: ['help', 'house', 'kids', 'work', 'load', 'responsibility'] },
  { label: 'intimacy and connection', words: ['close', 'affection', 'intimacy', 'sex', 'distance'] },
];

const PATTERN_RULES = [
  { label: 'defensiveness', test: /(not my fault|you started|that's because you|i only did that because)/i },
  { label: 'criticism', test: /\b(always|never)\b/i },
  { label: 'stonewalling', test: /(whatever|i'm done|leave me alone|i don't care)/i },
  { label: 'contempt', test: /(ridiculous|pathetic|crazy|embarrassing|disgusting)/i },
];

export const createInviteCode = (): string =>
  randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();

export const getSessionStartBlocker = (gate: HomeworkGate | null | undefined): string | null => {
  if (!gate) {
    return null;
  }

  const missingReflections = gate.assignments.some((assignment) => assignment.reflections.length < gate.requiredReflections);
  return missingReflections
    ? 'Both partners must submit the current homework reflection before the next session can open.'
    : null;
};

export const summarizeHomeworkGate = (gate: HomeworkGate | null | undefined): string => {
  if (!gate) {
    return 'No active homework gate. The couple can open a new session when both partners are ready.';
  }

  return gate.assignments
    .map((assignment) => `${assignment.title} (${assignment.reflections.length}/${gate.requiredReflections} reflections submitted)`)
    .join(' | ');
};

export const inferObservedPatterns = (
  transcriptSegments: TranscriptSegment[],
  interventions: InterventionEvent[],
): string[] => {
  const joined = transcriptSegments.map((segment) => segment.text).join(' ').toLowerCase();
  const patterns = new Set<string>();

  for (const rule of PATTERN_RULES) {
    if (rule.test.test(joined)) {
      patterns.add(rule.label);
    }
  }

  if (interventions.length > 0) {
    patterns.add('circular escalation');
  }

  if (patterns.size === 0) {
    patterns.add('emotional flooding');
  }

  return [...patterns];
};

export const inferCoreConflict = (transcriptSegments: TranscriptSegment[]): string => {
  const joined = transcriptSegments.map((segment) => segment.text).join(' ').toLowerCase();

  const scored = CONFLICT_KEYWORDS.map((entry) => ({
    label: entry.label,
    score: entry.words.reduce((total, word) => total + (joined.includes(word) ? 1 : 0), 0),
  })).sort((left, right) => right.score - left.score);

  return scored[0]?.score ? `Recurring conflict around ${scored[0].label}` : 'Breakdown in accountability and emotional safety';
};

/**
 * Build fallback homework when the LLM fails to generate dynamic prompts.
 * These are still tailored to the core conflict rather than being fully static.
 */
export const buildDefaultHomework = (
  coreConflict: string,
  observedPatterns: string[] = [],
): HomeworkAssignment[] => {
  const patternClause = observedPatterns.length > 0
    ? ` The patterns observed were: ${observedPatterns.join(', ')}.`
    : '';

  return [
    {
      id: randomUUID(),
      title: 'Truth Window',
      description: `Each partner writes one paragraph naming their specific part in the ${coreConflict.toLowerCase()}.${patternClause}`,
      reflectionPrompt: `Thinking about the ${coreConflict.toLowerCase()} discussed in this session: What specific thing did YOU do or say that made things worse? Do not mention your partner — only your own actions.`,
    },
    {
      id: randomUUID(),
      title: 'Pattern Recognition',
      description: `Identify one moment from this session where you fell into a destructive pattern${patternClause ? ' (' + observedPatterns.join(', ') + ')' : ''} and describe what you could have done instead.`,
      reflectionPrompt: `Name one specific moment from this session where you were not being fully honest or accountable. What were you actually feeling underneath the reaction?`,
    },
  ];
};

export const clampHonestyScore = (value: number): number => Math.max(1, Math.min(100, Math.round(value)));

export const buildFallbackTruthReport = (
  transcriptSegments: TranscriptSegment[],
  interventions: InterventionEvent[],
  previousSummary: string,
): TruthReport => {
  const coreConflict = inferCoreConflict(transcriptSegments);
  const observedPatterns = inferObservedPatterns(transcriptSegments, interventions);
  const honestyScore = clampHonestyScore(
    78 - interventions.length * 8 - (observedPatterns.includes('criticism') ? 10 : 0) - (observedPatterns.includes('contempt') ? 15 : 0),
  );

  const truthSummary = previousSummary
    ? `The couple is revisiting a known pattern: ${previousSummary}. They still shift into ${observedPatterns.join(', ')} instead of staying accountable.`
    : `The session centered on ${coreConflict.toLowerCase()}. The main issue was not lack of feeling, but lack of clean accountability.`;

  return {
    coreConflict,
    truthSummary,
    observedPatterns,
    homework: buildDefaultHomework(coreConflict, observedPatterns),
    nextGoal: 'Return with evidence that both partners can name their contribution without immediately counterattacking.',
    honestyScore,
    clinicalFrame: 'Direct professional',
  };
};

export const normalizeTruthReport = (
  rawReport: Partial<TruthReport>,
  transcriptSegments: TranscriptSegment[],
  interventions: InterventionEvent[],
  previousSummary: string,
): TruthReport => {
  const fallback = buildFallbackTruthReport(transcriptSegments, interventions, previousSummary);

  return {
    coreConflict: rawReport.coreConflict?.trim() || fallback.coreConflict,
    truthSummary: rawReport.truthSummary?.trim() || fallback.truthSummary,
    observedPatterns:
      rawReport.observedPatterns?.filter((pattern): pattern is string => Boolean(pattern && pattern.trim())) ??
      fallback.observedPatterns,
    homework:
      rawReport.homework?.map((assignment) => ({
        id: assignment.id || randomUUID(),
        title: assignment.title?.trim() || 'Practice direct accountability',
        description: assignment.description?.trim() || 'Return with one concrete example of changed behavior.',
        reflectionPrompt:
          assignment.reflectionPrompt?.trim() ||
          'What part of your own pattern are you still trying to excuse?',
      })) ?? fallback.homework,
    nextGoal: rawReport.nextGoal?.trim() || fallback.nextGoal,
    honestyScore: clampHonestyScore(rawReport.honestyScore ?? fallback.honestyScore),
    clinicalFrame: rawReport.clinicalFrame?.trim() || fallback.clinicalFrame,
  };
};

export const buildSessionContextSummary = (
  previousSummary: string,
  gate: HomeworkGate | null | undefined,
): string => {
  const parts: string[] = [];

  if (previousSummary) {
    parts.push(`Previous session memory: ${previousSummary}`);
  } else {
    parts.push('This is the couple\'s first session — no prior session memory exists yet.');
  }

  const gateSummary = summarizeHomeworkGate(gate);
  parts.push(`Homework gate status: ${gateSummary}`);

  // Include homework reflection content if available
  if (gate?.assignments) {
    for (const assignment of gate.assignments) {
      if (assignment.reflections.length > 0) {
        parts.push(`Homework "${assignment.title}":`);
        for (const reflection of assignment.reflections) {
          parts.push(`  - Partner reflection (completed: ${reflection.completed}): "${reflection.reflection}"`);
        }
      }
    }
  }

  return parts.join('\n');
};

const countWords = (value: string): number =>
  value
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

export const isMeaningfulSessionAttempt = (args: {
  transcriptSegments: TranscriptSegment[];
  interventions: InterventionEvent[];
  metrics: SessionMetrics;
}): boolean => {
  const conversationalTurns = args.transcriptSegments.filter((segment) => segment.source !== 'system');
  const partnerTurns = conversationalTurns.filter(
    (segment) => segment.source === 'frontend-webspeech' || segment.source === 'livekit-user',
  );
  const mirrorTurns = conversationalTurns.filter((segment) => segment.source === 'agent-livekit');
  const partnerWordCount = partnerTurns.reduce((total, segment) => total + countWords(segment.text), 0);
  const totalWordCount = conversationalTurns.reduce((total, segment) => total + countWords(segment.text), 0);

  if (partnerTurns.length >= 2 && totalWordCount >= 24) {
    return true;
  }

  if (partnerTurns.length >= 1 && mirrorTurns.length >= 1 && totalWordCount >= 18) {
    return true;
  }

  if (args.interventions.length >= 2 && partnerWordCount >= 12) {
    return true;
  }

  return false;
};
