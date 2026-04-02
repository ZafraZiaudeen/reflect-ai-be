import { AccessToken } from 'livekit-server-sdk';
import { initializeLogger, loggerOptions, voice } from '@livekit/agents';
import { Room, RoomEvent, TrackKind, type Participant, type RemoteParticipant } from '@livekit/rtc-node';
import { VoiceTelemetryApplication } from '../../application/VoiceTelemetryApplication.js';
import { getModelAttemptOrder, type SpeakerRole } from '../../domain/Types/mirror.js';
import { env, ensureEnvValue } from '../Config/env.js';
import { createOpenRouterLlm } from '../OpenRouter/openRouterService.js';

type AgentMetadata = {
  sessionId: string;
  selectedModel: string;
  openingContext: string;
  partnerAUserId: string;
  partnerAName: string;
  partnerBUserId?: string;
  partnerBName?: string;
  homeworkTitle?: string;
  reflectionContext?: string;
  hasReflections?: string;
};

type HumanParticipant = {
  identity: string;
  userId: string;
  role: SpeakerRole;
  label: string;
};

type LocalMirrorFallbackState = {
  readyPromise: Promise<void>;
  runPromise: Promise<void>;
};

type InternalFuture = {
  done: boolean;
  resolve: () => void;
};

type InternalParticipantAudioOutput = {
  startedFuture?: InternalFuture;
};

interface StartLocalMirrorFallbackInput {
  roomName: string;
  metadata: Record<string, string>;
}

const RECONNECT_GRACE_MS = 90_000;
const SOLO_ONLY_START_DELAY_MS = 2_000;
const PARTNER_WAIT_TIMEOUT_MS = 15_000;
const PARTICIPANT_SWITCH_COOLDOWN_MS = 1_200;
const ROOM_STATE_REEVALUATION_DELAY_MS = 250;
const INTERRUPTION_MIN_DURATION_MS = 550;
const INTERRUPTION_MIN_WORDS = 2;
const AUDIO_OUTPUT_SUBSCRIPTION_GRACE_MS = 1_500;

/* ------------------------------------------------------------------ */
/*  Real-time honesty scoring                                           */
/* ------------------------------------------------------------------ */

const HONESTY_RULES = {
  defensiveness: {
    patterns: [/not my fault/i, /you started/i, /that's because you/i, /i only did that because/i, /you made me/i],
    honestyDelta: -12,
    escalationDelta: 10,
  },
  criticism: {
    patterns: [/you always/i, /you never/i, /what is wrong with you/i, /why can't you/i],
    honestyDelta: -10,
    escalationDelta: 8,
  },
  contempt: {
    patterns: [/ridiculous/i, /pathetic/i, /disgusting/i, /you're crazy/i, /grow up/i, /whatever/i],
    honestyDelta: -18,
    escalationDelta: 14,
  },
  stonewalling: {
    patterns: [/i'm done/i, /leave me alone/i, /i don't care/i, /forget it/i],
    honestyDelta: -14,
    escalationDelta: 11,
  },
  denial: {
    patterns: [/that's not true/i, /you're wrong/i, /i didn't say that/i, /that's not what happened/i],
    honestyDelta: -10,
    escalationDelta: 12,
  },
  accountability: {
    patterns: [/i realize/i, /i was wrong/i, /my fault/i, /i should have/i, /i'm sorry/i, /i admit/i],
    honestyDelta: 6,
    escalationDelta: -8,
  },
};

const analyzeUtteranceForHonesty = (text: string): { honestyDelta: number; escalationDelta: number } => {
  let honestyDelta = 0;
  let escalationDelta = 0;
  let matched = false;

  for (const [, rule] of Object.entries(HONESTY_RULES)) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        honestyDelta += rule.honestyDelta;
        escalationDelta += rule.escalationDelta;
        matched = true;
        break;
      }
    }
  }

  if (!matched) {
    honestyDelta += 1;
    escalationDelta -= 3;
  }

  return { honestyDelta, escalationDelta };
};

const clampScore = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.round(value)));

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

const activeFallbacks = new Map<string, LocalMirrorFallbackState>();

const ensureAgentsLogger = (): void => {
  if (loggerOptions()) {
    return;
  }

  initializeLogger({
    pretty: env.NODE_ENV !== 'production',
    level: env.NODE_ENV === 'development' ? 'debug' : 'info',
  });
};

const parseAgentMetadata = (rawMetadata: string | undefined): Partial<AgentMetadata> => {
  try {
    return JSON.parse((rawMetadata || '{}') as string) as Partial<AgentMetadata>;
  } catch {
    return {};
  }
};

const readParticipantMetadata = (participant: Participant | RemoteParticipant): Record<string, string> => {
  if (!participant.metadata) {
    return {};
  }

  try {
    const parsed = JSON.parse(participant.metadata) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, value == null ? '' : String(value)]),
    );
  } catch {
    return {};
  }
};

const resolveHumanParticipant = (
  participant: Participant | RemoteParticipant,
  context: {
    partnerAUserId: string;
    partnerAName: string;
    partnerBUserId?: string;
    partnerBName?: string;
  },
): HumanParticipant | null => {
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

  if (
    roleFromMetadata === 'partner_b' ||
    (context.partnerBUserId && (userId === context.partnerBUserId || identityUserId === context.partnerBUserId))
  ) {
    return {
      identity: participant.identity,
      userId: context.partnerBUserId || '',
      role: 'partner_b',
      label: context.partnerBName || 'Partner B',
    };
  }

  return null;
};

const buildHoldingLine = (name: string): string =>
  `Welcome, ${name}. I'm Mirror, your session guide. Your partner hasn't joined the room yet, so stay with me and we'll begin together as soon as they're here.`;

const buildSoloWelcomeLine = (name: string): string =>
  `Welcome, ${name}. It is just you and me right now. Give me the blunt truth about what is breaking down between you two.`;

const buildFullWelcomeLine = (args: {
  partnerAName: string;
  partnerBName: string;
  homeworkTitle?: string;
  hasReflections?: boolean;
}): string => {
  if (args.hasReflections) {
    return [
      `Welcome back, ${args.partnerAName} and ${args.partnerBName}.`,
      'Before we do anything else, I want to talk about what you both wrote in your reflections.',
      'I have read every word. Let us see if you meant them.',
    ].join(' ');
  }

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

const createAgentToken = async (roomName: string): Promise<string> => {
  const accessToken = new AccessToken(
    ensureEnvValue(env.LIVEKIT_API_KEY, 'LIVEKIT_API_KEY'),
    ensureEnvValue(env.LIVEKIT_API_SECRET, 'LIVEKIT_API_SECRET'),
    {
      identity: `mirror-local:${roomName}`,
      name: 'Mirror',
      metadata: JSON.stringify({
        role: 'mirror',
        source: 'local-fallback',
      }),
    },
  );

  accessToken.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return accessToken.toJwt();
};

export const isLocalMirrorFallbackEnabled = (): boolean => env.NODE_ENV !== 'production';

export const isLocalMirrorFallbackActive = (roomName: string): boolean => activeFallbacks.has(roomName);

export const ensureLocalMirrorFallback = async ({
  roomName,
  metadata,
}: StartLocalMirrorFallbackInput): Promise<void> => {
  if (!isLocalMirrorFallbackEnabled()) {
    return;
  }

  const existingState = activeFallbacks.get(roomName);
  if (existingState) {
    await existingState.readyPromise;
    return;
  }

  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const runPromise = (async () => {
    ensureAgentsLogger();

    // Validate critical API keys early so failures surface clearly instead of
    // silently producing a voice agent that cannot do STT / TTS.
    if (!process.env.DEEPGRAM_API_KEY) {
      console.warn(
        'DEEPGRAM_API_KEY is not set. The LiveKit voice agent requires a Deepgram key for STT/TTS. ' +
        'Sign up at https://deepgram.com for $200 free credit.',
      );
    }

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
    let currentLinkedParticipantIdentity: string | null = null;
    let lastParticipantSwitchAt = 0;
    let holdingLineDelivered = false;
    let welcomedBothPartners = false;
    let hasHadHumanPresence = false;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let roomStateEvaluationTimer: NodeJS.Timeout | null = null;
    let soloStartTimer: NodeJS.Timeout | null = null;
    let audioOutputStartTimer: NodeJS.Timeout | null = null;
    let promptsArmed = false;
    let closed = false;

    const humanParticipants = new Map<string, HumanParticipant>();
    // Track honesty metrics in real-time
    let honestyScore = 50;
    let escalationLevel = 25;
    const HONESTY_UPDATE_INTERVAL = 5;
    let utterancesSinceHonestyUpdate = 0;

    const buildVoiceAgent = (modelId: string) => {
      const instructionParts = [
        THERAPIST_GUARDRAILS,
        'Respond with Gemini Live-style energy: quick turn-taking, low dead air, and short spoken replies that sound present in the room.',
        'When one partner speaks directly to you, answer immediately instead of waiting for a long exchange.',
        `Partner A is ${coupleContext.partnerAName}.`,
        `Partner B is ${coupleContext.partnerBName || 'Partner B'}.`,
      ];

      // Include opening context with full memory
      const openingContext = parsedMetadata.openingContext || '';
      if (openingContext) {
        instructionParts.push('');
        instructionParts.push('SESSION CONTEXT AND MEMORY:');
        instructionParts.push(openingContext);
      }

      // Include reflection context
      const reflectionCtx = parsedMetadata.reflectionContext || '';
      if (reflectionCtx) {
        instructionParts.push('');
        instructionParts.push('CRITICAL INSTRUCTION — REFLECTION REVIEW:');
        instructionParts.push('When both partners are in the room, your FIRST priority is to review and discuss the reflections they wrote.');
        instructionParts.push('Read their reflections back to them. Ask if they meant what they wrote. Push for honesty.');
        instructionParts.push('Do NOT move to general conversation until you have addressed the reflections.');
        instructionParts.push(reflectionCtx);
      }

      return new voice.Agent({
        instructions: instructionParts.join(' '),
        llm: createOpenRouterLlm(modelId, 0.42),
      });
    };

    let currentAgent = buildVoiceAgent(modelAttempts[currentModelIndex]!.id);

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

    const disconnectPromise = new Promise<void>((resolve) => {
      room.once(RoomEvent.Disconnected, () => {
        closed = true;
        resolve();
      });
    });

    const speakLine = (text: string, allowInterruptions = false) => {
      ensureRoomAudioOutputReady();
      const handle = liveSession.say(text, {
        allowInterruptions,
        addToChatCtx: true,
      });
      handle.waitForPlayout().catch((error) => {
        console.warn(`[local-fallback] speakLine playout failed for room ${roomName}:`, error);
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

      const roomIO = liveSession._roomIO as
        | {
            participantAudioOutput?: InternalParticipantAudioOutput;
          }
        | undefined;
      const participantAudioOutput = roomIO?.participantAudioOutput;
      if (!participantAudioOutput?.startedFuture || participantAudioOutput.startedFuture.done) {
        return;
      }

      audioOutputStartTimer = setTimeout(() => {
        const latestRoomIO = liveSession._roomIO as
          | {
              participantAudioOutput?: InternalParticipantAudioOutput;
            }
          | undefined;
        const latestParticipantAudioOutput = latestRoomIO?.participantAudioOutput;
        if (!latestParticipantAudioOutput?.startedFuture || latestParticipantAudioOutput.startedFuture.done) {
          return;
        }

        console.warn(
          `Mirror audio output did not confirm a subscription within ${AUDIO_OUTPUT_SUBSCRIPTION_GRACE_MS}ms. Forcing output start for room ${roomName}.`,
        );
        latestParticipantAudioOutput.startedFuture.resolve();
      }, AUDIO_OUTPUT_SUBSCRIPTION_GRACE_MS);
    };

    const shutdownRoom = (reason: string) => {
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

    const retargetToParticipant = (identity: string | null): boolean => {
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

    const syncParticipant = (participant: Participant | RemoteParticipant) => {
      const resolved = resolveHumanParticipant(participant, coupleContext);
      if (!resolved) {
        return;
      }

      humanParticipants.set(participant.identity, resolved);
    };

    const unregisterParticipant = (participant: Participant | RemoteParticipant) => {
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

      speakLine(buildSoloWelcomeLine(soloName));
    };

    let evaluateRoomState = () => {};

    const scheduleRoomStateEvaluation = (delay = ROOM_STATE_REEVALUATION_DELAY_MS) => {
      clearRoomStateEvaluationTimer();
      roomStateEvaluationTimer = setTimeout(() => {
        roomStateEvaluationTimer = null;
        evaluateRoomState();
      }, Math.max(0, delay));
    };

    const closeSessionForEmptyRoom = async () => {
      await VoiceTelemetryApplication.markInterrupted(
        sessionId,
        'Both partners left the room and did not return before the reconnect grace window ended.',
      );
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

      const firstParticipant = [...humanParticipants.values()][0]!;
      if (!retargetToParticipant(firstParticipant.identity)) {
        return;
      }

      if (participantCount === 1 && !welcomedBothPartners) {
        if (!holdingLineDelivered) {
          holdingLineDelivered = true;
          speakLine(buildHoldingLine(firstParticipant.label));
        }

        if (!soloStartTimer) {
          const delay = coupleContext.partnerBUserId ? PARTNER_WAIT_TIMEOUT_MS : SOLO_ONLY_START_DELAY_MS;
          soloStartTimer = setTimeout(startSoloSession, delay);
        }
        return;
      }

      if (participantCount >= 2 && !welcomedBothPartners) {
        welcomedBothPartners = true;
        clearSoloStartTimer();

        const hasReflections = parsedMetadata.hasReflections === 'true';
        speakLine(
          buildFullWelcomeLine({
            partnerAName: coupleContext.partnerAName,
            partnerBName: coupleContext.partnerBName || 'Partner B',
            homeworkTitle: coupleContext.homeworkTitle,
            hasReflections,
          }),
        );

        // Queue a follow-up reflection discussion prompt
        if (hasReflections) {
          setTimeout(() => {
            const queueHandle = liveSession.generateReply({
              instructions: [
                'Now review the reflections both partners wrote (included in your context).',
                'Summarize what each partner wrote in their own words.',
                'Ask each partner directly: "Did you mean what you wrote, or were you performing for the exercise?"',
                'Look for contradictions between their reflections and their past behavior.',
                'Do NOT move on to new topics until the reflections have been discussed.',
              ].join(' '),
              allowInterruptions: true,
            });
            queueHandle.waitForPlayout().catch(() => undefined);
          }, 6_000);
        }
      }
    };

    liveSession.on(voice.AgentSessionEventTypes.Error, async (event) => {
      const source = event.source as
        | {
            label?: () => string;
          }
        | undefined;
      const sourceLabel = typeof source?.label === 'function' ? source.label() : '';
      const errorMessage =
        event.error instanceof Error ? event.error.message.toLowerCase() : String(event.error ?? '').toLowerCase();
      const shouldRotateModel =
        sourceLabel.toLowerCase().includes('llm') &&
        /(402|429|503|credit|max_tokens|max completion|failed to generate llm completion|insufficient quota|rate.?limit|overloaded|capacity|too many requests)/i.test(
          errorMessage,
        );

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

      await VoiceTelemetryApplication.appendAssistantTranscript(
        sessionId,
        `Mirror switched to ${nextModel.label} and kept the room open.`,
        ['model-fallback', 'local-fallback'],
      );
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

      const transcript = event.transcript.trim();

      await VoiceTelemetryApplication.appendPartnerTranscript({
        sessionId,
        speakerUserId: activeParticipant.userId,
        speakerRole: activeParticipant.role,
        speakerLabel: activeParticipant.label,
        text: transcript,
        createdAt: new Date(event.createdAt),
        source: 'livekit-user',
        tags: ['canonical-livekit', 'local-fallback'],
      });

      // Real-time honesty scoring
      const honestyAnalysis = analyzeUtteranceForHonesty(transcript);
      honestyScore = clampScore(honestyScore + honestyAnalysis.honestyDelta, 1, 100);
      escalationLevel = clampScore(escalationLevel + honestyAnalysis.escalationDelta, 0, 100);

      utterancesSinceHonestyUpdate += 1;
      if (utterancesSinceHonestyUpdate >= HONESTY_UPDATE_INTERVAL) {
        utterancesSinceHonestyUpdate = 0;
        void VoiceTelemetryApplication.updateHonestyScore(sessionId, honestyScore);
      }
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
