export const DEFAULT_MODEL_ID = 'anthropic/claude-sonnet-4.6';
export const REPORT_MODEL_ID = 'openai/gpt-5.2-chat';
export const MODEL_CATALOG = [
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
export const getModelOption = (modelId) => MODEL_CATALOG.find((model) => model.id === modelId) ??
    MODEL_CATALOG.find((model) => model.isDefault) ??
    MODEL_CATALOG[0];
export const getModelAttemptOrder = (modelId, options) => {
    const primaryModel = getModelOption(modelId);
    const orderedIds = options?.preferReportModel
        ? [REPORT_MODEL_ID, primaryModel.id, ...primaryModel.fallbackModelIds]
        : [primaryModel.id, ...primaryModel.fallbackModelIds];
    return [...new Set(orderedIds)].map((id) => getModelOption(id));
};
export const toObjectIdString = (value) => String(value);
