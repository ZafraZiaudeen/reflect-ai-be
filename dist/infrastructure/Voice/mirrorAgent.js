import { fileURLToPath } from 'node:url';
import { AutoSubscribe, defineAgent, voice } from '@livekit/agents';
import { RoomEvent, TrackKind } from '@livekit/rtc-node';
import { getModelAttemptOrder, } from '../../domain/Types/mirror.js';
const RECONNECT_GRACE_MS = 90_000;
const EVIDENCE_WINDOW_MS = 90_000;
const MAX_EVIDENCE_ENTRIES = 16;
const INTERVENTION_COOLDOWN_MS = 7_000;
const OVERLAP_COOLDOWN_MS = 5_000;
const PARTICIPANT_SWITCH_COOLDOWN_MS = 1_200;
const ROOM_STATE_REEVALUATION_DELAY_MS = 250;
const DB_INIT_TIMEOUT_MS = 4_000;
const SOLO_ONLY_START_DELAY_MS = 2_000;
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
const INTERRUPT_LIBRARY = [
    'Stop. Both of you just left the issue and moved into collision.',
    'Pause. You are arguing to win, not to understand.',
    'I am interrupting because the pattern is getting louder than the truth.',
];
const HOLDING_LINE_TEMPLATE = (name) => `Welcome, ${name}. I'm Mirror, your session guide. Your partner hasn't joined the room yet — sit tight, and we'll begin together as soon as they're here.`;
let runtimeDependenciesPromise = null;
const getRuntimeDependencies = () => {
    runtimeDependenciesPromise ??= Promise.all([
        import('../../application/VoiceTelemetryApplication.js'),
        import('../../domain/Models/Couple.js'),
        import('../../domain/Models/Session.js'),
        import('../Database/connectDatabase.js'),
        import('../OpenRouter/openRouterService.js'),
    ]).then(([voiceTelemetryModule, coupleModule, sessionModule, databaseModule, openRouterModule]) => ({
        VoiceTelemetryApplication: voiceTelemetryModule.VoiceTelemetryApplication,
        CoupleModel: coupleModule.CoupleModel,
        SessionModel: sessionModule.SessionModel,
        connectDatabase: databaseModule.connectDatabase,
        createOpenRouterLlm: openRouterModule.createOpenRouterLlm,
    }));
    return runtimeDependenciesPromise;
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
const formatEvidenceTime = (timestamp) => {
    const date = new Date(timestamp);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};
const trimEvidenceWindow = (entries) => {
    const cutoff = Date.now() - EVIDENCE_WINDOW_MS;
    while (entries.length > 0 && (entries[0].createdAt < cutoff || entries.length > MAX_EVIDENCE_ENTRIES)) {
        entries.shift();
    }
};
const buildEvidenceSnippet = (entries) => {
    const partnerEvidence = entries.filter((entry) => entry.source === 'partner').slice(-3);
    if (partnerEvidence.length === 0) {
        return 'No partner transcript evidence is stored in the short-term buffer yet.';
    }
    return partnerEvidence
        .map((entry) => `[${formatEvidenceTime(entry.createdAt)}] ${entry.speakerLabel}: ${entry.text}`)
        .join('\n');
};
const resolveHumanParticipant = (participant, couple) => {
    const metadata = readParticipantMetadata(participant);
    const roleFromMetadata = metadata.role;
    const userId = metadata.userId;
    const identityUserId = participant.identity.includes(':')
        ? participant.identity.split(':').at(-1) || participant.identity
        : participant.identity;
    if (roleFromMetadata === 'partner_a' || userId === couple.partnerAUserId || identityUserId === couple.partnerAUserId) {
        return {
            identity: participant.identity,
            userId: couple.partnerAUserId,
            role: 'partner_a',
            label: couple.partnerAName,
        };
    }
    if (roleFromMetadata === 'partner_b' ||
        (couple.partnerBUserId && (userId === couple.partnerBUserId || identityUserId === couple.partnerBUserId))) {
        return {
            identity: participant.identity,
            userId: couple.partnerBUserId || '',
            role: 'partner_b',
            label: couple.partnerBName || 'Partner B',
        };
    }
    return null;
};
const shouldInterveneFromTranscript = (entries) => {
    const recentPartnerTurns = entries.filter((entry) => entry.source === 'partner').slice(-3);
    if (recentPartnerTurns.length < 3) {
        return false;
    }
    const span = recentPartnerTurns.at(-1).createdAt - recentPartnerTurns[0].createdAt;
    const repeatedAbsolutes = recentPartnerTurns.some((turn) => /\b(always|never|nothing|everything)\b/i.test(turn.text));
    const contemptLanguage = recentPartnerTurns.some((turn) => /(ridiculous|crazy|pathetic|whatever|shut up|you always|you never|disgusting)/i.test(turn.text));
    return span < 10_000 || repeatedAbsolutes || contemptLanguage;
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
const buildInterventionDecision = (args) => {
    const normalizedTranscript = args.transcript.trim();
    if (!normalizedTranscript) {
        return null;
    }
    const evidenceSnippet = buildEvidenceSnippet(args.evidenceEntries);
    const hasDenial = /\b(you'?re wrong|that'?s not true|i didn'?t|i never|no i don'?t|not what happened)\b/i.test(normalizedTranscript);
    const attacksTheAgent = /\b(bot|machine|ai|you don'?t know us|what do you know|you are not real|shut up mirror)\b/i.test(normalizedTranscript);
    const refusesToEngage = /\b(i'?m done|we'?re done|whatever|leave me alone|not doing this|end this|stop talking)\b/i.test(normalizedTranscript);
    if (refusesToEngage || (args.resistanceLevel >= 2 && (hasDenial || attacksTheAgent))) {
        const line = 'If your goal is to dodge the work instead of face it, I will close this session. Choose honesty or we stop here.';
        return {
            stage: 'continue_or_close',
            severity: 'red',
            reason: 'Refusal to engage honestly',
            line,
            prompt: [
                `Start with this exact line: "${line}"`,
                'Then give one final chance to continue honestly.',
                'Use evidence from the short-term transcript buffer to justify the warning.',
                evidenceSnippet,
            ].join('\n'),
            resistanceDelta: 1,
        };
    }
    if (attacksTheAgent) {
        const line = 'Notice how fast you turned your anger toward me the moment I named the pattern. That is the defense I am talking about.';
        return {
            stage: 'mirror',
            severity: 'firm',
            reason: 'Attack against the AI used as a defense move',
            line,
            prompt: [
                `Start with this exact line: "${line}"`,
                'Then explain that attacking the referee is proof of avoidance, not proof that the observation is wrong.',
                'Use the evidence buffer to cite the last defensive move plainly.',
                evidenceSnippet,
            ].join('\n'),
            resistanceDelta: 1,
        };
    }
    if (hasDenial) {
        const line = 'I am not guessing. The transcript from the last minute already shows the contradiction.';
        return {
            stage: 'quote_evidence',
            severity: 'firm',
            reason: 'Denial or contradiction detected',
            line,
            prompt: [
                `Start with this exact line: "${line}"`,
                'Then quote the strongest recent evidence from the transcript buffer with timestamps and ask why the story changed.',
                evidenceSnippet,
            ].join('\n'),
            resistanceDelta: 1,
        };
    }
    if (shouldInterveneFromTranscript(args.evidenceEntries)) {
        const line = INTERRUPT_LIBRARY[Math.floor(Math.random() * INTERRUPT_LIBRARY.length)];
        return {
            stage: 'interrupt',
            severity: 'firm',
            reason: 'Rapid escalation, contempt, or circular arguing',
            line,
            prompt: [
                `Start with this exact line: "${line}"`,
                'Then name the destructive pattern in one sentence and force one partner to answer with accountability instead of rebuttal.',
                evidenceSnippet,
            ].join('\n'),
            resistanceDelta: 0,
        };
    }
    return null;
};
export default defineAgent({
    entry: async (ctx) => {
        await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
        const runtimeDependencies = await getRuntimeDependencies();
        const { CoupleModel, SessionModel, VoiceTelemetryApplication, connectDatabase, createOpenRouterLlm } = runtimeDependencies;
        const metadata = parseAgentMetadata(ctx.job.metadata);
        const sessionId = metadata.sessionId;
        if (!sessionId) {
            throw new Error('Missing sessionId in dispatch metadata.');
        }
        const sessionFallback = {
            selectedModel: metadata.selectedModel || 'google/gemini-2.5-flash',
            homeworkTitle: metadata.homeworkTitle,
        };
        const coupleFallback = {
            partnerAUserId: metadata.partnerAUserId || '',
            partnerAName: metadata.partnerAName || 'Partner A',
            partnerBUserId: metadata.partnerBUserId,
            partnerBName: metadata.partnerBName || 'Partner B',
        };
        let sessionRecord = null;
        let couple = null;
        // Race the DB lookup against a tight deadline so the agent can start
        // even when MongoDB is slow. Metadata from the dispatch payload is the
        // fallback.
        try {
            const dbResult = await Promise.race([
                (async () => {
                    await connectDatabase({ retries: 1 });
                    const session = await SessionModel.findById(sessionId);
                    const coupleDoc = session ? await CoupleModel.findById(session.coupleId) : null;
                    return { session, couple: coupleDoc };
                })(),
                new Promise((resolve) => setTimeout(() => resolve({ session: null, couple: null }), DB_INIT_TIMEOUT_MS)),
            ]);
            sessionRecord = dbResult.session;
            couple = dbResult.couple;
        }
        catch (error) {
            console.warn(`Mirror agent started without an initial database snapshot for session ${sessionId}.`, error);
        }
        if (!couple && !coupleFallback.partnerAUserId) {
            throw new Error(`Couple context for session ${sessionId} could not be resolved.`);
        }
        const coupleContext = couple
            ? {
                partnerAUserId: couple.partnerAUserId,
                partnerAName: couple.partnerAName,
                partnerBUserId: couple.partnerBUserId,
                partnerBName: couple.partnerBName || 'Partner B',
                homeworkTitle: couple.activeHomeworkGate?.assignments[0]?.title,
            }
            : {
                ...coupleFallback,
                homeworkTitle: sessionFallback.homeworkTitle,
            };
        const modelAttempts = getModelAttemptOrder(metadata.selectedModel || sessionRecord?.selectedModel || sessionFallback.selectedModel);
        let currentModelIndex = 0;
        let switchingModels = false;
        let currentLinkedParticipantIdentity = null;
        let lastParticipantSwitchAt = 0;
        let holdingLineDelivered = false;
        let welcomedBothPartners = false;
        let hasHadHumanPresence = false;
        let lastInterventionAt = 0;
        let resistanceLevel = 0;
        let reconnectTimer = null;
        let roomStateEvaluationTimer = null;
        let audioOutputStartTimer = null;
        let promptsArmed = false;
        const humanParticipants = new Map();
        const evidenceEntries = [];
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
                console.warn(`Mirror audio output did not confirm a subscription within ${AUDIO_OUTPUT_SUBSCRIPTION_GRACE_MS}ms for session ${sessionId}. Forcing output start.`);
                latestParticipantAudioOutput.startedFuture.resolve();
            }, AUDIO_OUTPUT_SUBSCRIPTION_GRACE_MS);
        };
        const queuePrompt = (instructions, allowInterruptions = false) => {
            ensureRoomAudioOutputReady();
            liveSession.generateReply({
                instructions,
                allowInterruptions,
            });
        };
        const speakLine = (text, allowInterruptions = false) => {
            ensureRoomAudioOutputReady();
            liveSession.say(text, {
                allowInterruptions,
                addToChatCtx: true,
            });
        };
        const registerEvidence = (entry) => {
            evidenceEntries.push(entry);
            trimEvidenceWindow(evidenceEntries);
        };
        const getCurrentHumanParticipant = () => {
            if (currentLinkedParticipantIdentity && humanParticipants.has(currentLinkedParticipantIdentity)) {
                return humanParticipants.get(currentLinkedParticipantIdentity);
            }
            if (humanParticipants.size === 1) {
                return [...humanParticipants.values()][0];
            }
            return null;
        };
        const clearRoomStateEvaluationTimer = () => {
            if (!roomStateEvaluationTimer) {
                return;
            }
            clearTimeout(roomStateEvaluationTimer);
            roomStateEvaluationTimer = null;
        };
        let evaluateRoomState = () => { };
        const scheduleRoomStateEvaluation = (delay = ROOM_STATE_REEVALUATION_DELAY_MS) => {
            clearRoomStateEvaluationTimer();
            roomStateEvaluationTimer = setTimeout(() => {
                roomStateEvaluationTimer = null;
                evaluateRoomState();
            }, Math.max(0, delay));
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
                // Audio pipeline not ready yet — retry after a short delay
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
        const clearReconnectTimer = () => {
            if (!reconnectTimer) {
                return;
            }
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        };
        const closeSessionForEmptyRoom = async () => {
            clearRoomStateEvaluationTimer();
            clearAudioOutputStartTimer();
            await VoiceTelemetryApplication.markInterrupted(sessionId, 'Both partners left the room and did not return before the reconnect grace window ended.');
            liveSession.shutdown({
                reason: 'room_empty_timeout',
            });
            ctx.shutdown('room_empty_timeout');
        };
        let soloStartTimer = null;
        const clearSoloStartTimer = () => {
            if (soloStartTimer) {
                clearTimeout(soloStartTimer);
                soloStartTimer = null;
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
                    speakLine(buildHoldingLine(firstParticipant.label));
                }
                // If no partner B exists for this session, allow the solo fallback.
                if (!coupleContext.partnerBUserId && !soloStartTimer) {
                    // No partner B at all — start immediately after the holding line.
                    soloStartTimer = setTimeout(startSoloSession, SOLO_ONLY_START_DELAY_MS);
                }
                else if (coupleContext.partnerBUserId) {
                    // Partner B exists but has not joined yet — give them time.
                    clearSoloStartTimer();
                }
                return;
            }
            if (participantCount >= 2 && !welcomedBothPartners) {
                welcomedBothPartners = true;
                clearSoloStartTimer();
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
            await VoiceTelemetryApplication.appendAssistantTranscript(sessionId, `Mirror switched to ${nextModel.label} and kept the room open.`, ['model-fallback']);
            if (humanParticipants.size > 0) {
                speakLine('I am re-centering the room and continuing. Stay with the issue.');
            }
        });
        liveSession.on(voice.AgentSessionEventTypes.UserInputTranscribed, async (event) => {
            if (!event.isFinal || !event.transcript.trim()) {
                return;
            }
            const activeParticipant = getCurrentHumanParticipant();
            if (!activeParticipant) {
                return;
            }
            const transcript = event.transcript.trim();
            registerEvidence({
                speakerRole: activeParticipant.role,
                speakerLabel: activeParticipant.label,
                text: transcript,
                createdAt: event.createdAt,
                source: 'partner',
            });
            await VoiceTelemetryApplication.appendPartnerTranscript({
                sessionId,
                speakerUserId: activeParticipant.userId,
                speakerRole: activeParticipant.role,
                speakerLabel: activeParticipant.label,
                text: transcript,
                createdAt: new Date(event.createdAt),
                source: 'livekit-user',
                tags: ['canonical-livekit'],
            });
            if (humanParticipants.size < 2 && !welcomedBothPartners) {
                return;
            }
            trimEvidenceWindow(evidenceEntries);
            if (Date.now() - lastInterventionAt < INTERVENTION_COOLDOWN_MS) {
                resistanceLevel = Math.max(0, resistanceLevel - 1);
                return;
            }
            const decision = buildInterventionDecision({
                transcript,
                evidenceEntries,
                resistanceLevel,
            });
            if (!decision) {
                resistanceLevel = Math.max(0, resistanceLevel - 1);
                return;
            }
            resistanceLevel = Math.max(0, resistanceLevel + (decision.resistanceDelta ?? 0));
            lastInterventionAt = Date.now();
            await VoiceTelemetryApplication.appendIntervention({
                sessionId,
                stage: decision.stage,
                severity: decision.severity,
                reason: decision.reason,
                line: decision.line,
                prompt: decision.prompt,
            });
            queuePrompt(decision.prompt);
        });
        liveSession.on(voice.AgentSessionEventTypes.OverlappingSpeech, async (event) => {
            if (Date.now() - lastInterventionAt < OVERLAP_COOLDOWN_MS) {
                return;
            }
            const line = 'Silence for ten seconds. Neither of you is listening.';
            const prompt = [
                `Start with this exact line: "${line}"`,
                'Then explain that talking over each other is proof of collapse, not progress.',
            ].join('\n');
            lastInterventionAt = Date.now();
            resistanceLevel += 1;
            await VoiceTelemetryApplication.appendIntervention({
                sessionId,
                stage: 'interrupt',
                severity: event.totalDurationInS >= 3 ? 'red' : 'firm',
                reason: 'Extended overlapping speech',
                line,
                prompt,
                overlapIncrement: 1,
            });
            queuePrompt(prompt);
        });
        liveSession.on(voice.AgentSessionEventTypes.ConversationItemAdded, async (event) => {
            if (event.item.type === 'message' && event.item.role === 'assistant' && event.item.textContent) {
                registerEvidence({
                    speakerRole: 'mirror',
                    speakerLabel: 'Mirror',
                    text: event.item.textContent,
                    createdAt: Date.now(),
                    source: 'mirror',
                });
                await VoiceTelemetryApplication.appendAssistantTranscript(sessionId, event.item.textContent, ['assistant-turn']);
            }
        });
        ctx.room.on(RoomEvent.ParticipantConnected, (participant) => {
            syncParticipant(participant);
            ensureRoomAudioOutputReady();
            evaluateRoomState();
        });
        ctx.room.on(RoomEvent.LocalTrackSubscribed, () => {
            clearAudioOutputStartTimer();
        });
        ctx.room.on(RoomEvent.TrackPublished, (publication, participant) => {
            if (publication.kind === TrackKind.KIND_AUDIO) {
                evaluateRoomState();
            }
        });
        ctx.room.on(RoomEvent.ParticipantMetadataChanged, (_metadata, participant) => {
            syncParticipant(participant);
            evaluateRoomState();
        });
        ctx.room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
            const activeHuman = speakers.find((speaker) => humanParticipants.has(speaker.identity));
            if (!activeHuman) {
                return;
            }
            retargetToParticipant(activeHuman.identity);
        });
        ctx.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
            unregisterParticipant(participant);
            const nextHuman = [...humanParticipants.values()][0];
            retargetToParticipant(nextHuman?.identity ?? null);
            evaluateRoomState();
        });
        await liveSession.start({
            agent: currentAgent,
            room: ctx.room,
            inputOptions: {
                closeOnDisconnect: false,
            },
        });
        for (const participant of ctx.room.remoteParticipants.values()) {
            syncParticipant(participant);
        }
        await VoiceTelemetryApplication.markSessionLive(sessionId);
        // Give the audio pipeline a moment to fully initialise before the first
        // prompt, otherwise generateReply may fire before TTS is connected.
        await new Promise((resolve) => setTimeout(resolve, 800));
        promptsArmed = true;
        evaluateRoomState();
    },
});
export const mirrorAgentPath = fileURLToPath(new URL('./mirrorAgent.ts', import.meta.url));
