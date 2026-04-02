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

export interface WorkspaceInvitation {
  email: string;
  recipientName?: string;
  invitedByUserId: string;
  invitedByName: string;
  sentAt: Date;
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
  source: 'frontend-webspeech' | 'livekit-user' | 'agent-livekit' | 'system';
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
  pendingInvitation: WorkspaceInvitation | null;
}

export interface SessionSummary {
  id: string;
  coupleId: string;
  roomName: string;
  status: SessionStatus;
  selectedModel: string;
  createdByUserId: string;
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
  activeSession?: SessionSummary | null;
}

export interface CreateCoupleInput {
  displayName?: string;
  email?: string;
  avatarUrl?: string;
}

export interface JoinCoupleInput extends CreateCoupleInput {
  inviteCode: string;
}

export interface SendWorkspaceInviteInput {
  email: string;
  recipientName?: string;
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

export const DEFAULT_MODEL_ID = 'anthropic/claude-sonnet-4.6';
export const REPORT_MODEL_ID = 'openai/gpt-5.2-chat';

export const MODEL_CATALOG: ModelOption[] = [
  {
    id: 'anthropic/claude-sonnet-4.6',
    label: 'Claude Sonnet 4.6',
    provider: 'OpenRouter',
    supportsVoice: true,
    isDefault: true,
    description: 'Balanced default for live sessions with sharp therapeutic language and strong nuance.',
    latency: 'balanced',
    fallbackModelIds: ['anthropic/claude-opus-4.5', 'openai/gpt-5.2-chat'],
  },
  {
    id: 'anthropic/claude-opus-4.6',
    label: 'Claude Opus 4.6',
    provider: 'OpenRouter',
    supportsVoice: true,
    isDefault: false,
    description: 'Deepest confrontational reasoning for the most clinically demanding sessions.',
    latency: 'deep',
    fallbackModelIds: ['anthropic/claude-opus-4.5', 'anthropic/claude-sonnet-4.6'],
  },
  {
    id: 'anthropic/claude-opus-4.5',
    label: 'Claude Opus 4.5',
    provider: 'OpenRouter',
    supportsVoice: true,
    isDefault: false,
    description: 'Deep reasoning fallback with a forceful, reflective tone when Sonnet is unavailable.',
    latency: 'deep',
    fallbackModelIds: ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.2-chat'],
  },
  {
    id: 'openai/gpt-5.2-chat',
    label: 'GPT-5.2 Chat',
    provider: 'OpenRouter',
    supportsVoice: true,
    isDefault: false,
    description: 'Reliable structured output model for truth reports and disciplined turn-taking.',
    latency: 'balanced',
    fallbackModelIds: ['anthropic/claude-sonnet-4.6', 'google/gemini-2.5-flash'],
  },
  {
    id: 'google/gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    provider: 'OpenRouter',
    supportsVoice: true,
    isDefault: false,
    description: 'Fastest low-latency option for aggressive interruption handling and recovery.',
    latency: 'fast',
    fallbackModelIds: ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.2-chat'],
  },
];

export const getModelOption = (modelId?: string): ModelOption =>
  MODEL_CATALOG.find((model) => model.id === modelId) ??
  MODEL_CATALOG.find((model) => model.isDefault) ??
  MODEL_CATALOG[0];

export const getModelAttemptOrder = (
  modelId?: string,
  options?: {
    preferReportModel?: boolean;
  },
): ModelOption[] => {
  const primaryModel = getModelOption(modelId);
  const orderedIds = options?.preferReportModel
    ? [REPORT_MODEL_ID, primaryModel.id, ...primaryModel.fallbackModelIds]
    : [primaryModel.id, ...primaryModel.fallbackModelIds];

  return [...new Set(orderedIds)].map((id) => getModelOption(id));
};

export const toObjectIdString = (value: Types.ObjectId | string): string => String(value);
