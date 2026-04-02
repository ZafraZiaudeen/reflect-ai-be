import { cli, ServerOptions } from '@livekit/agents';
import { mirrorAgentPath } from './mirrorAgent.js';
import { env } from '../Config/env.js';

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
