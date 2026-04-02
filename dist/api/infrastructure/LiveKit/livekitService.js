import { AccessToken, AgentDispatchClient } from 'livekit-server-sdk';
import { env, ensureEnvValue } from '../Config/env.js';
const getLiveKitControlHost = () => {
    const liveKitUrl = ensureEnvValue(env.LIVEKIT_URL, 'LIVEKIT_URL');
    if (liveKitUrl.startsWith('wss://')) {
        return liveKitUrl.replace('wss://', 'https://');
    }
    if (liveKitUrl.startsWith('ws://')) {
        return liveKitUrl.replace('ws://', 'http://');
    }
    return liveKitUrl;
};
const createDispatchClient = () => new AgentDispatchClient(getLiveKitControlHost(), ensureEnvValue(env.LIVEKIT_API_KEY, 'LIVEKIT_API_KEY'), ensureEnvValue(env.LIVEKIT_API_SECRET, 'LIVEKIT_API_SECRET'));
export const createParticipantToken = async ({ roomName, identity, name, metadata, }) => {
    const accessToken = new AccessToken(ensureEnvValue(env.LIVEKIT_API_KEY, 'LIVEKIT_API_KEY'), ensureEnvValue(env.LIVEKIT_API_SECRET, 'LIVEKIT_API_SECRET'), {
        identity,
        name,
        metadata: JSON.stringify(metadata),
    });
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
export const dispatchMirrorAgent = async ({ roomName, metadata, }) => {
    const dispatchClient = createDispatchClient();
    const dispatch = await dispatchClient.createDispatch(roomName, env.LIVEKIT_AGENT_NAME, {
        metadata: JSON.stringify(metadata),
    });
    return dispatch.id;
};
export const clearMirrorAgentDispatch = async ({ roomName, dispatchId, }) => {
    const dispatchClient = createDispatchClient();
    await dispatchClient.deleteDispatch(dispatchId, roomName);
};
