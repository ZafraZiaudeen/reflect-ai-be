import { cli, ServerOptions } from '@livekit/agents';
import { env } from '../../infrastructure/Config/env.js';
import { mirrorAgentPath } from '../../infrastructure/Voice/mirrorAgent.js';

const isDevMode = process.argv.slice(2).includes('dev');

cli.runApp(
  new ServerOptions({
    agent: mirrorAgentPath,
    agentName: env.LIVEKIT_AGENT_NAME,
    wsURL: env.LIVEKIT_URL,
    apiKey: env.LIVEKIT_API_KEY,
    apiSecret: env.LIVEKIT_API_SECRET,
    initializeProcessTimeout: 120_000,
    ...(isDevMode ? { numIdleProcesses: 1 } : {}),
  }),
);