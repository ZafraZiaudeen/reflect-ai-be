import { AccessToken, AgentDispatchClient } from 'livekit-server-sdk';
import { env, ensureEnvValue } from '../Config/env.js';

interface DispatchInput {
  roomName: string;
  sessionId: string;
  coupleId: string;
  selectedModel: string;
  openingContext: string;
}

interface TokenInput {
  roomName: string;
  identity: string;
  name: string;
  metadata: Record<string, string>;
}

const getLiveKitControlHost = (): string => {
  const liveKitUrl = ensureEnvValue(env.LIVEKIT_URL, 'LIVEKIT_URL');
  if (liveKitUrl.startsWith('wss://')) {
    return liveKitUrl.replace('wss://', 'https://');
  }
  if (liveKitUrl.startsWith('ws://')) {
    return liveKitUrl.replace('ws://', 'http://');
  }
  return liveKitUrl;
};

export const createParticipantToken = async ({
  roomName,
  identity,
  name,
  metadata,
}: TokenInput): Promise<{ token: string; serverUrl: string }> => {
  const accessToken = new AccessToken(
    ensureEnvValue(env.LIVEKIT_API_KEY, 'LIVEKIT_API_KEY'),
    ensureEnvValue(env.LIVEKIT_API_SECRET, 'LIVEKIT_API_SECRET'),
    {
      identity,
      name,
      metadata: JSON.stringify(metadata),
    },
  );

  accessToken.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return {
    token: await accessToken.toJwt(),
    serverUrl: ensureEnvValue(env.LIVEKIT_URL, 'LIVEKIT_URL'),
  };
};

export const dispatchMirrorAgent = async ({
  roomName,
  sessionId,
  coupleId,
  selectedModel,
  openingContext,
}: DispatchInput): Promise<string> => {
  const dispatchClient = new AgentDispatchClient(
    getLiveKitControlHost(),
    ensureEnvValue(env.LIVEKIT_API_KEY, 'LIVEKIT_API_KEY'),
    ensureEnvValue(env.LIVEKIT_API_SECRET, 'LIVEKIT_API_SECRET'),
  );

  const dispatch = await dispatchClient.createDispatch(roomName, env.LIVEKIT_AGENT_NAME, {
    metadata: JSON.stringify({
      sessionId,
      coupleId,
      selectedModel,
      openingContext,
    }),
  });

  return dispatch.id;
};
