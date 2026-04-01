import type { Types } from 'mongoose';

export type SessionStatus = 'pending' | 'live' | 'completed' | 'interrupted';
export type SpeakerRole = 'partner_a' | 'partner_b' | 'mirror' | 'system' | 'participant_unknown';
export type InterventionStage = 'interrupt' | 'quote_evidence' | 'mirror' | 'continue_or_close';
export type InterventionSeverity = 'watch' | 'firm' | 'red';

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  supportsVoice: boolean;
  isDefault: boolean;
  description: string;
  latency: 'fast' | 'balanced' | 'deep';
  fallbackModelIds: string[];
}

export interface HomeworkAssignment {
  id: string;
  title: string;
  description: string;
  reflectionPrompt: string;
}

export interface HomeworkReflection {
  userId: string;
  completed: boolean;
  reflection: string;
  submittedAt: Date;
}

export interface HomeworkGateAssignment extends HomeworkAssignment {
  reflections: HomeworkReflection[];
}

export interface HomeworkGate {
  sourceSessionId: string;
  createdAt: Date;
  assignments: HomeworkGateAssignment[];
  requiredReflections: number;
  unlockedAt?: Date | null;
}

export interface TranscriptSegment {
  speakerUserId?: string | null;
  speakerRole: SpeakerRole;
  speakerLabel: string;
  text: string;
  createdAt: Date;
  startedAtMs?: number;
  endedAtMs?: number;
  confidence?: number;
  source: 'frontend-webspeech' | 'agent-livekit' | 'system';
  tags: string[];
}

export interface InterventionEvent {
  id: string;
  stage: InterventionStage;
  severity: InterventionSeverity;
  reason: string;
  line: string;
  prompt: string;
  createdAt: Date;
}

export interface SessionMetrics {
  interventionCount: number;
  overlapCount: number;
  localTranscriptCount: number;
  agentTranscriptCount: number;
  honestyScore: number;
  durationMs: number;
}

export interface TruthReport {
  coreConflict: string;
  truthSummary: string;
  observedPatterns: string[];
  homework: HomeworkAssignment[];
  nextGoal: string;
  honestyScore: number;
  clinicalFrame: string;
}

export interface CoupleSummary {
  id: string;
  inviteCode: string;
  preferredModel: string;
  partnerA: {
    userId: string;
    displayName: string;
    email?: string;
  };
  partnerB?: {
    userId: string;
    displayName: string;
    email?: string;
  };
  memorySummary: string;
  activeHomeworkGate: HomeworkGate | null;
}

export interface SessionSummary {
  id: string;
  coupleId: string;
  roomName: string;
  status: SessionStatus;
  selectedModel: string;
  startedAt?: string | null;
  endedAt?: string | null;
  report?: TruthReport | null;
  transcriptSegments: TranscriptSegment[];
  interventions: InterventionEvent[];
  metrics: SessionMetrics;
}

export interface DashboardResponse {
  couple: CoupleSummary | null;
  sessions: SessionSummary[];
  models: ModelOption[];
  canStartSession: boolean;
  blockerReason?: string;
}

export interface CreateCoupleInput {
  displayName?: string;
  email?: string;
  avatarUrl?: string;
}

export interface JoinCoupleInput extends CreateCoupleInput {
  inviteCode: string;
}

export interface HomeworkReflectionInput {
  assignmentId: string;
  completed: boolean;
  reflection: string;
}

export interface PartnerTranscriptInput {
  text: string;
  startedAtMs?: number;
  endedAtMs?: number;
  confidence?: number;
}

export const DEFAULT_MODEL_ID = 'anthropic/claude-sonnet-4';

export const MODEL_CATALOG: ModelOption[] = [
  {
    id: 'anthropic/claude-sonnet-4',
    label: 'Claude Sonnet 4',
    provider: 'OpenRouter',
    supportsVoice: true,
    isDefault: true,
    description: 'Best overall balance for nuanced, high-empathy confrontation.',
    latency: 'balanced',
    fallbackModelIds: ['anthropic/claude-3.7-sonnet', 'openai/gpt-4.1'],
  },
  {
    id: 'anthropic/claude-3.7-sonnet',
    label: 'Claude 3.7 Sonnet',
    provider: 'OpenRouter',
    supportsVoice: true,
    isDefault: false,
    description: 'Strong conversational reasoning with a familiar Claude tone.',
    latency: 'balanced',
    fallbackModelIds: ['anthropic/claude-sonnet-4', 'openai/gpt-4.1'],
  },
  {
    id: 'openai/gpt-4.1',
    label: 'GPT-4.1',
    provider: 'OpenRouter',
    supportsVoice: true,
    isDefault: false,
    description: 'Reliable structured outputs and session summaries.',
    latency: 'balanced',
    fallbackModelIds: ['openai/gpt-4.1-mini', 'anthropic/claude-sonnet-4'],
  },
  {
    id: 'google/gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    provider: 'OpenRouter',
    supportsVoice: true,
    isDefault: false,
    description: 'Lowest-latency fallback for quicker turn handling.',
    latency: 'fast',
    fallbackModelIds: ['openai/gpt-4.1-mini', 'anthropic/claude-sonnet-4'],
  },
];

export const getModelOption = (modelId?: string): ModelOption =>
  MODEL_CATALOG.find((model) => model.id === modelId) ??
  MODEL_CATALOG.find((model) => model.isDefault) ??
  MODEL_CATALOG[0];

export const toObjectIdString = (value: Types.ObjectId | string): string => String(value);
