import { cli, ServerOptions } from '@livekit/agents';
import { env, ensureEnvValue } from '../../infrastructure/Config/env.js';
import { mirrorAgentPath } from '../../infrastructure/Voice/mirrorAgent.js';

const isDevMode = process.argv.slice(2).includes('dev');
const livekitUrl = ensureEnvValue(env.LIVEKIT_URL?.trim(), 'LIVEKIT_URL');
const livekitApiKey = ensureEnvValue(env.LIVEKIT_API_KEY?.trim(), 'LIVEKIT_API_KEY');
const livekitApiSecret = ensureEnvValue(env.LIVEKIT_API_SECRET?.trim(), 'LIVEKIT_API_SECRET');

cli.runApp(
  new ServerOptions({
    agent: mirrorAgentPath,
    agentName: env.LIVEKIT_AGENT_NAME,
    wsURL: livekitUrl,
    apiKey: livekitApiKey,
    apiSecret: livekitApiSecret,
    initializeProcessTimeout: 120_000,
    ...(isDevMode ? { numIdleProcesses: 1 } : {}),
  }),
);