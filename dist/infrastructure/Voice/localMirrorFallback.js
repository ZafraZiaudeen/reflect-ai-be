import { AccessToken } from 'livekit-server-sdk';
import { initializeLogger, loggerOptions, voice } from '@livekit/agents';
import { Room, RoomEvent, TrackKind } from '@livekit/rtc-node';
import { VoiceTelemetryApplication } from '../../application/VoiceTelemetryApplication.js';
import { getModelAttemptOrder } from '../../domain/Types/mirror.js';
import { env, ensureEnvValue } from '../Config/env.js';
import { createOpenRouterLlm } from '../OpenRouter/openRouterService.js';
const RECONNECT_GRACE_MS = 90_000;
const SOLO_ONLY_START_DELAY_MS = 2_000;
const PARTICIPANT_SWITCH_COOLDOWN_MS = 1_200;
const ROOM_STATE_REEVALUATION_DELAY_MS = 250;
const INTERRUPTION_MIN_DURATION_MS = 550;
const INTERRUPTION_MIN_WORDS = 2;
const AUDIO_OUTPUT_SUBSCRIPTION_GRACE_MS = 1_500;
const THERAPIST_GUARDRAILS = [
    'You are Project Mirror, a world-class couples mediator.',
    'You are direct, high-status, clinically grounded, and truth-first.',
    'You do not use apologetic or submissive phrasing.',
    'You call out defensiveness, contempt, avoidance, dishonesty, circular arguing, and victim narratives plainly.',
    'If the couple attacks you, explain how that attack proves the same defensive pattern you are naming.',
    'If they refuse to engage honestly, warn that you will close the session rather than waste time.',
    'Use short spoken turns, barge in early when the room turns chaotic, and end strong exchanges with one concrete accountability question.',
    'Do not claim to be a licensed therapist, do not diagnose, and do not provide crisis treatment.',
].join(' ');
const activeFallbacks = new Map();
const ensureAgentsLogger = () => {
    if (loggerOptions()) {
        return;
    }
    initializeLogger({
        pretty: env.NODE_ENV !== 'production',
        level: env.NODE_ENV === 'development' ? 'debug' : 'info',
    });
};
const parseAgentMetadata = (rawMetadata) => {
    try {
        return JSON.parse((rawMetadata || '{}'));
    }
    catch {
        return {};
    }
};
const readParticipantMetadata = (participant) => {
    if (!participant.metadata) {
        return {};
    }
    try {
        const parsed = JSON.parse(participant.metadata);
        return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, value == null ? '' : String(value)]));
    }
    catch {
        return {};
    }
};
const resolveHumanParticipant = (participant, context) => {
    const metadata = readParticipantMetadata(participant);
    const roleFromMetadata = metadata.role;
    const userId = metadata.userId;
    const identityUserId = participant.identity.includes(':')
        ? participant.identity.split(':').at(-1) || participant.identity
        : participant.identity;
    if (roleFromMetadata === 'partner_a' || userId === context.partnerAUserId || identityUserId === context.partnerAUserId) {
        return {
            identity: participant.identity,
            userId: context.partnerAUserId,
            role: 'partner_a',
            label: context.partnerAName,
        };
    }
    if (roleFromMetadata === 'partner_b' ||
        (context.partnerBUserId && (userId === context.partnerBUserId || identityUserId === context.partnerBUserId))) {
        return {
            identity: participant.identity,
            userId: context.partnerBUserId || '',
            role: 'partner_b',
            label: context.partnerBName || 'Partner B',
        };
    }
    return null;
};
const buildHoldingLine = (name) => `Welcome, ${name}. I'm Mirror, your session guide. Your partner hasn't joined the room yet, so stay with me and we'll begin together as soon as they're here.`;
const buildSoloWelcomeLine = (name) => `Welcome, ${name}. It is just you and me right now. Give me the blunt truth about what is breaking down between you two.`;
const buildFullWelcomeLine = (args) => {
    const homeworkCheck = args.homeworkTitle
        ? `Before either of you performs, tell me whether you actually completed "${args.homeworkTitle}".`
        : 'I am here for relationship truth, not polished excuses.';
    return [
        `Welcome to the room, ${args.partnerAName} and ${args.partnerBName}.`,
        homeworkCheck,
        'Which one of you is going to say the hard thing first?',
    ]
        .filter(Boolean)
        .join(' ');
};
const createAgentToken = async (roomName) => {
    const accessToken = new AccessToken(ensureEnvValue(env.LIVEKIT_API_KEY, 'LIVEKIT_API_KEY'), ensureEnvValue(env.LIVEKIT_API_SECRET, 'LIVEKIT_API_SECRET'), {
        identity: `mirror-local:${roomName}`,
        name: 'Mirror',
        metadata: JSON.stringify({
            role: 'mirror',
            source: 'local-fallback',
        }),
    });
    accessToken.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
    });
    return accessToken.toJwt();
};
export const isLocalMirrorFallbackEnabled = () => env.NODE_ENV !== 'production';
export const isLocalMirrorFallbackActive = (roomName) => activeFallbacks.has(roomName);
export const ensureLocalMirrorFallback = async ({ roomName, metadata, }) => {
    if (!isLocalMirrorFallbackEnabled()) {
        return;
    }
    const existingState = activeFallbacks.get(roomName);
    if (existingState) {
        await existingState.readyPromise;
        return;
    }
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    const runPromise = (async () => {
        ensureAgentsLogger();
        const room = new Room();
        const parsedMetadata = parseAgentMetadata(JSON.stringify(metadata));
        const sessionId = parsedMetadata.sessionId;
        if (!sessionId) {
            throw new Error(`Local Mirror fallback cannot start for room ${roomName} without a sessionId.`);
        }
        const coupleContext = {
            partnerAUserId: parsedMetadata.partnerAUserId || '',
            partnerAName: parsedMetadata.partnerAName || 'Partner A',
            partnerBUserId: parsedMetadata.partnerBUserId,
            partnerBName: parsedMetadata.partnerBName || 'Partner B',
            homeworkTitle: parsedMetadata.homeworkTitle,
        };
        const modelAttempts = getModelAttemptOrder(parsedMetadata.selectedModel || 'google/gemini-2.5-flash');
        let currentModelIndex = 0;
        let switchingModels = false;
        let currentLinkedParticipantIdentity = null;
        let lastParticipantSwitchAt = 0;
        let holdingLineDelivered = false;
        let welcomedBothPartners = false;
        let hasHadHumanPresence = false;
        let reconnectTimer = null;
        let roomStateEvaluationTimer = null;
        let soloStartTimer = null;
        let audioOutputStartTimer = null;
        let promptsArmed = false;
        let closed = false;
        const humanParticipants = new Map();
        const buildVoiceAgent = (modelId) => new voice.Agent({
            instructions: [
                THERAPIST_GUARDRAILS,
                'Respond with Gemini Live-style energy: quick turn-taking, low dead air, and short spoken replies that sound present in the room.',
                'When one partner speaks directly to you, answer immediately instead of waiting for a long exchange.',
                `Partner A is ${coupleContext.partnerAName}.`,
                `Partner B is ${coupleContext.partnerBName || 'Partner B'}.`,
            ].join(' '),
            llm: createOpenRouterLlm(modelId, 0.42),
        });
        let currentAgent = buildVoiceAgent(modelAttempts[currentModelIndex].id);
        const liveSession = new voice.AgentSession({
            stt: 'deepgram/nova-3:en',
            tts: 'deepgram/aura-2',
            preemptiveGeneration: true,
            connOptions: {
                maxUnrecoverableErrors: 6,
            },
            turnHandling: {
                turnDetection: 'stt',
                endpointing: {
                    minDelay: 120,
                    maxDelay: 700,
                },
                interruption: {
                    enabled: true,
                    mode: 'vad',
                    minWords: INTERRUPTION_MIN_WORDS,
                    minDuration: INTERRUPTION_MIN_DURATION_MS,
                },
            },
        });
        const disconnectPromise = new Promise((resolve) => {
            room.once(RoomEvent.Disconnected, () => {
                closed = true;
                resolve();
            });
        });
        const speakLine = (text, allowInterruptions = false) => {
            liveSession.say(text, {
                allowInterruptions,
                addToChatCtx: true,
            });
        };
        const clearReconnectTimer = () => {
            if (!reconnectTimer) {
                return;
            }
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        };
        const clearRoomStateEvaluationTimer = () => {
            if (!roomStateEvaluationTimer) {
                return;
            }
            clearTimeout(roomStateEvaluationTimer);
            roomStateEvaluationTimer = null;
        };
        const clearSoloStartTimer = () => {
            if (!soloStartTimer) {
                return;
            }
            clearTimeout(soloStartTimer);
            soloStartTimer = null;
        };
        const clearAudioOutputStartTimer = () => {
            if (!audioOutputStartTimer) {
                return;
            }
            clearTimeout(audioOutputStartTimer);
            audioOutputStartTimer = null;
        };
        const ensureRoomAudioOutputReady = () => {
            clearAudioOutputStartTimer();
            const roomIO = liveSession._roomIO;
            const participantAudioOutput = roomIO?.participantAudioOutput;
            if (!participantAudioOutput?.startedFuture || participantAudioOutput.startedFuture.done) {
                return;
            }
            audioOutputStartTimer = setTimeout(() => {
                const latestRoomIO = liveSession._roomIO;
                const latestParticipantAudioOutput = latestRoomIO?.participantAudioOutput;
                if (!latestParticipantAudioOutput?.startedFuture || latestParticipantAudioOutput.startedFuture.done) {
                    return;
                }
                console.warn(`Mirror audio output did not confirm a subscription within ${AUDIO_OUTPUT_SUBSCRIPTION_GRACE_MS}ms. Forcing output start for room ${roomName}.`);
                latestParticipantAudioOutput.startedFuture.resolve();
            }, AUDIO_OUTPUT_SUBSCRIPTION_GRACE_MS);
        };
        const shutdownRoom = (reason) => {
            if (closed) {
                return;
            }
            closed = true;
            clearReconnectTimer();
            clearRoomStateEvaluationTimer();
            clearSoloStartTimer();
            clearAudioOutputStartTimer();
            liveSession.shutdown({ reason });
            void room.disconnect().catch(() => undefined);
        };
        const retargetToParticipant = (identity) => {
            if (identity === currentLinkedParticipantIdentity) {
                return true;
            }
            if (identity) {
                const elapsedSinceSwitch = Date.now() - lastParticipantSwitchAt;
                if (elapsedSinceSwitch < PARTICIPANT_SWITCH_COOLDOWN_MS) {
                    scheduleRoomStateEvaluation(PARTICIPANT_SWITCH_COOLDOWN_MS - elapsedSinceSwitch + 25);
                    return false;
                }
            }
            if (!liveSession._roomIO) {
                scheduleRoomStateEvaluation();
                return false;
            }
            liveSession._roomIO.setParticipant(identity);
            currentLinkedParticipantIdentity = identity;
            lastParticipantSwitchAt = Date.now();
            return true;
        };
        const syncParticipant = (participant) => {
            const resolved = resolveHumanParticipant(participant, coupleContext);
            if (!resolved) {
                return;
            }
            humanParticipants.set(participant.identity, resolved);
        };
        const unregisterParticipant = (participant) => {
            humanParticipants.delete(participant.identity);
            if (currentLinkedParticipantIdentity === participant.identity) {
                currentLinkedParticipantIdentity = null;
            }
        };
        const startSoloSession = () => {
            soloStartTimer = null;
            if (welcomedBothPartners) {
                return;
            }
            welcomedBothPartners = true;
            const soloParticipant = [...humanParticipants.values()][0];
            const soloName = soloParticipant?.label || coupleContext.partnerAName;
            ensureRoomAudioOutputReady();
            speakLine(buildSoloWelcomeLine(soloName));
        };
        let evaluateRoomState = () => { };
        const scheduleRoomStateEvaluation = (delay = ROOM_STATE_REEVALUATION_DELAY_MS) => {
            clearRoomStateEvaluationTimer();
            roomStateEvaluationTimer = setTimeout(() => {
                roomStateEvaluationTimer = null;
                evaluateRoomState();
            }, Math.max(0, delay));
        };
        const closeSessionForEmptyRoom = async () => {
            await VoiceTelemetryApplication.markInterrupted(sessionId, 'Both partners left the room and did not return before the reconnect grace window ended.');
            shutdownRoom('room_empty_timeout');
        };
        evaluateRoomState = () => {
            clearRoomStateEvaluationTimer();
            const participantCount = humanParticipants.size;
            if (participantCount > 0) {
                hasHadHumanPresence = true;
                clearReconnectTimer();
            }
            if (participantCount === 0) {
                currentLinkedParticipantIdentity = null;
                clearSoloStartTimer();
                if (!welcomedBothPartners) {
                    holdingLineDelivered = false;
                }
                if (hasHadHumanPresence && !reconnectTimer) {
                    reconnectTimer = setTimeout(() => {
                        void closeSessionForEmptyRoom();
                    }, RECONNECT_GRACE_MS);
                }
                return;
            }
            if (!promptsArmed) {
                return;
            }
            const firstParticipant = [...humanParticipants.values()][0];
            if (!retargetToParticipant(firstParticipant.identity)) {
                return;
            }
            if (participantCount === 1 && !welcomedBothPartners) {
                if (!holdingLineDelivered) {
                    holdingLineDelivered = true;
                    ensureRoomAudioOutputReady();
                    speakLine(buildHoldingLine(firstParticipant.label));
                }
                if (!coupleContext.partnerBUserId && !soloStartTimer) {
                    soloStartTimer = setTimeout(startSoloSession, SOLO_ONLY_START_DELAY_MS);
                }
                else if (coupleContext.partnerBUserId) {
                    clearSoloStartTimer();
                }
                return;
            }
            if (participantCount >= 2 && !welcomedBothPartners) {
                welcomedBothPartners = true;
                clearSoloStartTimer();
                ensureRoomAudioOutputReady();
                speakLine(buildFullWelcomeLine({
                    partnerAName: coupleContext.partnerAName,
                    partnerBName: coupleContext.partnerBName || 'Partner B',
                    homeworkTitle: coupleContext.homeworkTitle,
                }));
            }
        };
        liveSession.on(voice.AgentSessionEventTypes.Error, async (event) => {
            const source = event.source;
            const sourceLabel = typeof source?.label === 'function' ? source.label() : '';
            const errorMessage = event.error instanceof Error ? event.error.message.toLowerCase() : String(event.error ?? '').toLowerCase();
            const shouldRotateModel = sourceLabel.toLowerCase().includes('llm') &&
                /(402|credit|max_tokens|max completion|failed to generate llm completion|insufficient quota)/i.test(errorMessage);
            if (switchingModels || !shouldRotateModel) {
                return;
            }
            const nextModel = modelAttempts[currentModelIndex + 1];
            if (!nextModel) {
                return;
            }
            switchingModels = true;
            currentModelIndex += 1;
            currentAgent = buildVoiceAgent(nextModel.id);
            liveSession.updateAgent(currentAgent);
            switchingModels = false;
            await VoiceTelemetryApplication.appendAssistantTranscript(sessionId, `Mirror switched to ${nextModel.label} and kept the room open.`, ['model-fallback', 'local-fallback']);
        });
        liveSession.on(voice.AgentSessionEventTypes.UserInputTranscribed, async (event) => {
            if (!event.isFinal || !event.transcript.trim()) {
                return;
            }
            const activeIdentity = currentLinkedParticipantIdentity;
            const activeParticipant = activeIdentity ? humanParticipants.get(activeIdentity) : null;
            if (!activeParticipant) {
                return;
            }
            await VoiceTelemetryApplication.appendPartnerTranscript({
                sessionId,
                speakerUserId: activeParticipant.userId,
                speakerRole: activeParticipant.role,
                speakerLabel: activeParticipant.label,
                text: event.transcript.trim(),
                createdAt: new Date(event.createdAt),
                source: 'livekit-user',
                tags: ['canonical-livekit', 'local-fallback'],
            });
        });
        liveSession.on(voice.AgentSessionEventTypes.ConversationItemAdded, async (event) => {
            if (event.item.type !== 'message' || event.item.role !== 'assistant' || !event.item.textContent) {
                return;
            }
            await VoiceTelemetryApplication.appendAssistantTranscript(sessionId, event.item.textContent, [
                'assistant-turn',
                'local-fallback',
            ]);
        });
        room.on(RoomEvent.ParticipantConnected, (participant) => {
            syncParticipant(participant);
            ensureRoomAudioOutputReady();
            evaluateRoomState();
        });
        room.on(RoomEvent.LocalTrackSubscribed, () => {
            clearAudioOutputStartTimer();
        });
        room.on(RoomEvent.ParticipantMetadataChanged, (_metadata, participant) => {
            syncParticipant(participant);
            evaluateRoomState();
        });
        room.on(RoomEvent.TrackPublished, (publication) => {
            if (publication.kind === TrackKind.KIND_AUDIO) {
                evaluateRoomState();
            }
        });
        room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
            const activeHuman = speakers.find((speaker) => humanParticipants.has(speaker.identity));
            if (!activeHuman) {
                return;
            }
            retargetToParticipant(activeHuman.identity);
        });
        room.on(RoomEvent.ParticipantDisconnected, (participant) => {
            unregisterParticipant(participant);
            const nextHuman = [...humanParticipants.values()][0];
            retargetToParticipant(nextHuman?.identity ?? null);
            evaluateRoomState();
        });
        await room.connect(ensureEnvValue(env.LIVEKIT_URL, 'LIVEKIT_URL'), await createAgentToken(roomName), {
            autoSubscribe: true,
            dynacast: false,
        });
        await liveSession.start({
            agent: currentAgent,
            room,
            inputOptions: {
                closeOnDisconnect: false,
            },
        });
        for (const participant of room.remoteParticipants.values()) {
            syncParticipant(participant);
        }
        await VoiceTelemetryApplication.markSessionLive(sessionId);
        await new Promise((resolve) => setTimeout(resolve, 800));
        promptsArmed = true;
        evaluateRoomState();
        console.info(`Local Mirror fallback is ready in room ${roomName}.`);
        resolveReady();
        await disconnectPromise;
    })()
        .catch((error) => {
        rejectReady(error);
        console.warn(`Local Mirror fallback failed for room ${roomName}.`, error);
    })
        .finally(() => {
        activeFallbacks.delete(roomName);
    });
    activeFallbacks.set(roomName, {
        readyPromise,
        runPromise,
    });
    await readyPromise;
};
