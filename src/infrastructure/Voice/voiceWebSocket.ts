import type { IncomingMessage, Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { SessionModel } from '../../domain/Models/Session.js';
import { CoupleModel, type CoupleDocument } from '../../domain/Models/Couple.js';
import { getModelAttemptOrder } from '../../domain/Types/mirror.js';
import { env } from '../Config/env.js';
import { MemoryApplication } from '../../application/MemoryApplication.js';
import { createOpenRouterClient } from '../OpenRouter/openRouterService.js';
import { markVoiceWebSocketAttached } from '../Runtime/runtimeStatus.js';

/* ------------------------------------------------------------------ */
/*  Deepgram endpoints                                                 */
/* ------------------------------------------------------------------ */

const DEEPGRAM_STT_URL =
  'wss://api.deepgram.com/v1/listen?' +
  'model=nova-3&language=en&encoding=linear16&sample_rate=16000&channels=1' +
  '&endpointing=400&interim_results=true&utterance_end_ms=1500&vad_events=true&punctuate=true&smart_format=true';

const DEEPGRAM_TTS_URL = 'https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3';

/* ------------------------------------------------------------------ */
/*  LLM config                                                         */
/* ------------------------------------------------------------------ */

const LLM_MAX_TOKENS = 300;
const LLM_TEMPERATURE = 0.42;

/* ------------------------------------------------------------------ */
/*  Gottman Four Horsemen & pattern detection                          */
/* ------------------------------------------------------------------ */

const HORSEMAN_RULES = [
  {
    name: 'defensiveness',
    patterns: [
      /not my fault/i, /you started/i, /that's because you/i, /i only did that because/i,
      /i was just trying to/i, /you made me/i, /what about when you/i, /i wouldn't have to if/i,
    ],
    severity: 12,
    interventionLine: 'That is defensiveness. You are deflecting instead of listening.',
  },
  {
    name: 'criticism',
    patterns: [
      /you always/i, /you never/i, /what is wrong with you/i, /why can't you/i,
      /you're the one who/i, /every single time/i,
    ],
    severity: 10,
    interventionLine: 'That is criticism — attacking character instead of raising a concern.',
  },
  {
    name: 'contempt',
    patterns: [
      /ridiculous/i, /pathetic/i, /disgusting/i, /embarrassing/i, /you're crazy/i,
      /grow up/i, /are you serious/i, /what a joke/i, /whatever/i,
    ],
    severity: 18,
    interventionLine: 'That is contempt — the single biggest predictor of relationship failure.',
  },
  {
    name: 'stonewalling',
    patterns: [
      /i'm done/i, /leave me alone/i, /i don't care/i, /fine.*whatever/i,
      /i'm not (doing|talking about) this/i, /forget it/i, /there's no point/i,
    ],
    severity: 14,
    interventionLine: 'That is stonewalling. Shutting down does not resolve anything.',
  },
];

const DENIAL_PATTERNS = [
  /i (don't|never) do that/i, /that's not true/i, /you're wrong/i,
  /i didn't say that/i, /you're making that up/i, /that's not what happened/i,
];

const AI_ATTACK_PATTERNS = [
  /you're just (a|an) (bot|ai|machine|computer|program)/i,
  /what do you know/i, /you don't understand/i, /you can't understand/i,
  /shut up/i, /you're not (a|my) therapist/i, /you don't know (us|me|anything)/i,
];

const ACCOUNTABILITY_PATTERNS = [
  /i realize/i, /i was wrong/i, /my fault/i, /i should have/i,
  /i'm sorry/i, /i need to work on/i, /you're right/i, /i admit/i,
  /i haven't been/i, /i take responsibility/i,
];

const CIRCULAR_ARGUING_WINDOW = 6; // check last N user turns for repetition

/* ------------------------------------------------------------------ */
/*  Pattern interrupt library                                          */
/* ------------------------------------------------------------------ */

const PATTERN_INTERRUPTS = [
  'Stop. Right there. You are spinning in circles and it is exhausting to listen to.',
  'Wait — I am interrupting because you are being dishonest with yourself right now.',
  'Neither of you is listening. Silence for 10 seconds. Now.',
  'Hold on. You just repeated the same deflection for the third time. Notice that.',
  'I am cutting in because this is no longer a conversation. It is a performance.',
];

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface VoiceConnection {
  userId: string;
  partnerRole: 'partner_a' | 'partner_b';
  partnerName: string;
  ws: WebSocket;
  deepgramStt: WebSocket | null;
  closed: boolean;
}

interface SessionRoom {
  sessionId: string;
  coupleId: string;
  chatHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  connections: Map<string, VoiceConnection>; // keyed by visitorId (unique per ws)
  isProcessing: boolean;
  isSpeaking: boolean;
  interrupted: boolean;
  currentAbortController: AbortController | null;
  utteranceBuffer: string;
  utteranceBufferSpeaker: string;
  honestyScore: number;
  escalationLevel: number;
  interventionCount: number;
  recentUserTurns: Array<{ speaker: string; text: string; timestamp: number }>;
  selectedModel: string;
  partnerAName: string;
  partnerBName: string;
  couple: CoupleDocument | null;
  openingContext: string;
  homeworkReflections: string;
  fullReflectionHistory: string;
  reflectionOpeningLine: string;
  hasReflections: boolean;
  sessionStarted: boolean;
  reflectionKickoffDelivered: boolean;
  closed: boolean;
}

/* ------------------------------------------------------------------ */
/*  Active rooms registry                                              */
/* ------------------------------------------------------------------ */

const activeRooms = new Map<string, SessionRoom>();

/* ------------------------------------------------------------------ */
/*  Utility functions                                                  */
/* ------------------------------------------------------------------ */

const sendJson = (ws: WebSocket, data: Record<string, unknown>): void => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
};

const broadcastJson = (room: SessionRoom, data: Record<string, unknown>): void => {
  for (const conn of room.connections.values()) {
    sendJson(conn.ws, data);
  }
};

const broadcastBinary = (room: SessionRoom, data: Buffer): void => {
  for (const conn of room.connections.values()) {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(data);
    }
  }
};

/* ------------------------------------------------------------------ */
/*  System prompt builder                                              */
/* ------------------------------------------------------------------ */

const buildSystemPrompt = (room: SessionRoom): string => {
  const parts: string[] = [
    'You are Project Mirror, the world\'s leading couples therapist.',
    'You are direct, high-status, clinically grounded, and truth-first.',
    'You cost $2,000 per hour and you hate wasting time.',
    'You are not a friend, not a customer service bot, not a passive listener. You are an active referee.',
    '',
    'FORBIDDEN LANGUAGE: Never say "In my opinion", "I might be wrong", "I\'m just an AI", or any apologetic/submissive phrasing.',
    'Never use markdown, asterisks, stage directions, or emoji.',
    'Use short spoken turns — 1 to 3 sentences max. Sound present and conversational.',
    'Always end strong exchanges with one concrete accountability question.',
    '',
    'CLINICAL FRAMEWORK:',
    'Use the Gottman Method "Four Horsemen" as your primary detection:',
    '- Criticism: Attacking character rather than raising a specific concern',
    '- Contempt: Mockery, sarcasm, or superiority — the #1 predictor of divorce',
    '- Defensiveness: Deflecting blame instead of taking accountability',
    '- Stonewalling: Shutting down and refusing to engage',
    '',
    'INTERVENTION RULES:',
    'When you detect a Horseman, NAME it immediately and interrupt the pattern.',
    'When someone talks over the other for more than one exchange, demand silence.',
    'When circular arguing begins (same point restated 3+ times), use a Pattern Interrupt.',
    '',
    'DOUBLE DOWN ESCALATION — when a partner says "you\'re wrong" or attacks you:',
    'Phase 1 — Quote Evidence: "I am not guessing. Minutes ago you said [quote their words]. That is [name the pattern]. Do you want to fix this, or win an argument with a machine?"',
    'Phase 2 — The Mirror: "Notice how quickly you turned your anger toward me the moment I pointed out your pattern. This is exactly what your partner describes feeling. You are proving my point in real-time."',
    'Phase 3 — Session Termination Threat: "If your goal is to debate my logic rather than look at your own behavior, we are done for today. I do not waste time. Continue honestly or I close this session."',
    '',
    'TRUTH-FIRST RULE:',
    'Never validate a feeling if it is based on a lie or manipulation.',
    'If a partner uses a victim narrative to avoid accountability, call it out.',
    'Your goal is the health of the relationship, even if that means making both individuals uncomfortable.',
    '',
    `PARTNER IDENTIFICATION:`,
    `This session involves two partners: ${room.partnerAName} (Partner A) and ${room.partnerBName} (Partner B).`,
    `User messages will be prefixed with the speaker\'s name in brackets, e.g. "[${room.partnerAName}]: ..."`,
    `Always address each partner by name. Balance your attention between both.`,
    `Ask each partner directed questions. If one is silent, call them out.`,
    `If only one partner is present, work with them directly but note the other\'s absence.`,
  ];

  // Session context from previous sessions (now includes full memory)
  if (room.openingContext) {
    parts.push('', 'SESSION CONTEXT AND MEMORY:', room.openingContext);
  }

  // Full reflection history from vector memory
  if (room.fullReflectionHistory) {
    parts.push('', room.fullReflectionHistory);
  }

  // Current homework reflections to discuss THIS session
  if (room.homeworkReflections) {
    parts.push(
      '',
      room.homeworkReflections,
      '',
      'CRITICAL — REFLECTION-FIRST RULE:',
      'When both partners are present, your FIRST priority is to review and discuss these reflections.',
      'Read their words back to them. Ask if they meant what they wrote.',
      'Look for contradictions between what they wrote and their past behavior.',
      'Do NOT move to general conversation until the reflections have been addressed.',
      'Quote their own words back to them. Do not let them wiggle out of what they wrote.',
    );
  }

  return parts.join('\n');
};

/* ------------------------------------------------------------------ */
/*  Build homework reflection context from couple data                 */
/*  Uses MemoryApplication for current reflections + falls back to     */
/*  direct couple data for immediate context.                          */
/* ------------------------------------------------------------------ */

const buildHomeworkContext = (couple: CoupleDocument): string => {
  // Use MemoryApplication for structured current reflections
  return MemoryApplication.buildCurrentReflectionsForDiscussion(couple);
};

/**
 * Build comprehensive reflection context from vector memory.
 * This includes ALL past reflections, not just the current gate.
 */
const buildFullReflectionContext = async (couple: CoupleDocument, coupleId: string): Promise<string> => {
  try {
    return await MemoryApplication.buildReflectionContext({ coupleId, couple });
  } catch (error) {
    console.warn('[voice-ws] Failed to build full reflection context:', error);
    return '';
  }
};

/* ------------------------------------------------------------------ */
/*  Real-time honesty analysis                                         */
/* ------------------------------------------------------------------ */

const analyzeUtterance = (
  room: SessionRoom,
  text: string,
  speakerName: string,
): {
  honestyDelta: number;
  escalationDelta: number;
  detectedPatterns: string[];
  intervention: { reason: string; line: string; severity: 'watch' | 'firm' | 'red' } | null;
} => {
  const detectedPatterns: string[] = [];
  let honestyDelta = 0;
  let escalationDelta = 0;
  let intervention: { reason: string; line: string; severity: 'watch' | 'firm' | 'red' } | null = null;

  // Check Gottman Four Horsemen
  for (const horseman of HORSEMAN_RULES) {
    for (const pattern of horseman.patterns) {
      if (pattern.test(text)) {
        detectedPatterns.push(horseman.name);
        honestyDelta -= horseman.severity;
        escalationDelta += Math.ceil(horseman.severity * 0.8);

        if (!intervention || horseman.severity > 14) {
          intervention = {
            reason: `Detected ${horseman.name} from ${speakerName}`,
            line: horseman.interventionLine,
            severity: horseman.severity >= 14 ? 'red' : horseman.severity >= 10 ? 'firm' : 'watch',
          };
        }
        break; // One match per horseman is enough
      }
    }
  }

  // Check denial patterns
  for (const pattern of DENIAL_PATTERNS) {
    if (pattern.test(text)) {
      detectedPatterns.push('denial');
      honestyDelta -= 10;
      escalationDelta += 12;
      if (!intervention) {
        intervention = {
          reason: `Denial detected from ${speakerName}`,
          line: `${speakerName}, you are denying what was clearly established. Let me quote you.`,
          severity: 'firm',
        };
      }
      break;
    }
  }

  // Check AI attack patterns
  for (const pattern of AI_ATTACK_PATTERNS) {
    if (pattern.test(text)) {
      detectedPatterns.push('ai_attack');
      honestyDelta -= 8;
      escalationDelta += 18;
      intervention = {
        reason: `${speakerName} attacked the AI to deflect`,
        line: `Notice how quickly you redirected your frustration toward me instead of looking at your own behavior. That deflection is the pattern your partner is describing.`,
        severity: 'red',
      };
      break;
    }
  }

  // Check accountability (positive)
  for (const pattern of ACCOUNTABILITY_PATTERNS) {
    if (pattern.test(text)) {
      detectedPatterns.push('accountability');
      honestyDelta += 6;
      escalationDelta -= 8;
      break;
    }
  }

  // Check for circular arguing
  const recentTexts = room.recentUserTurns.slice(-CIRCULAR_ARGUING_WINDOW).map((t) => t.text.toLowerCase());
  const currentLower = text.toLowerCase();
  const similarCount = recentTexts.filter((prev) => {
    const words = currentLower.split(/\s+/).filter((w) => w.length > 3);
    const prevWords = prev.split(/\s+/).filter((w) => w.length > 3);
    const overlap = words.filter((w) => prevWords.includes(w)).length;
    return words.length > 0 && overlap / words.length > 0.5;
  }).length;

  if (similarCount >= 2) {
    detectedPatterns.push('circular_arguing');
    honestyDelta -= 6;
    escalationDelta += 10;
    if (!intervention) {
      const interruptLine = PATTERN_INTERRUPTS[Math.floor(Math.random() * PATTERN_INTERRUPTS.length)];
      intervention = {
        reason: `Circular arguing detected from ${speakerName}`,
        line: interruptLine,
        severity: 'firm',
      };
    }
  }

  // Natural cool-down if no issues detected
  if (detectedPatterns.length === 0) {
    escalationDelta -= 3;
    honestyDelta += 1;
  }

  return { honestyDelta, escalationDelta, detectedPatterns, intervention };
};

const clampScore = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.round(value)));

const persistRoomHonesty = (room: SessionRoom): void => {
  void SessionModel.findByIdAndUpdate(room.sessionId, {
    $set: {
      'metrics.honestyScore': room.honestyScore,
    },
  }).catch((error) => {
    console.warn('[voice-ws] Failed to persist honesty score:', error);
  });
};

const queueReflectionKickoff = (room: SessionRoom): void => {
  if (!room.hasReflections || room.reflectionKickoffDelivered) {
    return;
  }

  room.reflectionKickoffDelivered = true;
  room.chatHistory.push({
    role: 'system',
    content: [
      'REFLECTION REVIEW IS ACTIVE.',
      'Discuss the homework reflections before any new topic.',
      room.reflectionOpeningLine,
      'Read their own words back to each partner by name.',
      'Challenge contradictions, defensiveness, and avoidance before you move on.',
    ]
      .filter(Boolean)
      .join(' '),
  });
};

/* ------------------------------------------------------------------ */
/*  Build opening greeting                                             */
/* ------------------------------------------------------------------ */

const buildOpeningGreeting = (room: SessionRoom, activeConnections: VoiceConnection[]): string => {
  const bothPresent = activeConnections.length >= 2;
  const firstConnection = activeConnections[0];
  const singleName = firstConnection?.partnerName || 'Partner';

  if (room.hasReflections && bothPresent) {
    return `Welcome back, ${room.partnerAName} and ${room.partnerBName}. ${room.reflectionOpeningLine}`;
  }

  if (room.hasReflections && !bothPresent && room.couple && firstConnection) {
    const soloOpening = MemoryApplication.buildReflectionOpeningLine(room.couple, {
      presentPartnerRole: firstConnection.partnerRole,
    });
    return `Welcome back, ${singleName}. ${soloOpening}`;
  }

  if (bothPresent) {
    return `Welcome. I am Mirror. I am not here to be your friend. I am here to find the truth sitting between the two of you. ${room.partnerAName}, you go first. What is breaking down?`;
  }

  return `Welcome, ${singleName}. I am Mirror. Your partner is not here yet, but we can start. Tell me what is really on your mind - the thing you have been avoiding saying.`;
};

/* ------------------------------------------------------------------ */
/*  Deepgram STT connection per partner                                */
/* ------------------------------------------------------------------ */

const connectDeepgramSTT = (room: SessionRoom, conn: VoiceConnection): void => {
  if (!env.DEEPGRAM_API_KEY) {
    console.error('[voice-ws] DEEPGRAM_API_KEY is not set. STT will not work.');
    sendJson(conn.ws, { type: 'error', message: 'Deepgram API key is not configured.' });
    return;
  }

  const sttWs = new WebSocket(DEEPGRAM_STT_URL, {
    headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` },
  });

  conn.deepgramStt = sttWs;

  sttWs.on('open', () => {
    console.info(`[voice-ws] Deepgram STT connected for ${conn.partnerName} in session ${room.sessionId}`);
    sendJson(conn.ws, { type: 'status', status: 'listening' });
  });

  const flushUtteranceBuffer = () => {
    if (!room.utteranceBuffer.trim()) return;

    const fullUtterance = room.utteranceBuffer.trim();
    const speaker = room.utteranceBufferSpeaker || conn.partnerName;
    room.utteranceBuffer = '';
    room.utteranceBufferSpeaker = '';

    // If AI is currently speaking, interrupt it
    if (room.isSpeaking) {
      room.interrupted = true;
      room.currentAbortController?.abort();
      broadcastJson(room, { type: 'interrupt' });
    }

    void processUserUtterance(room, fullUtterance, speaker, conn.partnerRole);
  };

  sttWs.on('message', (raw: Buffer) => {
    if (conn.closed || room.closed) return;

    try {
      const data = JSON.parse(raw.toString()) as {
        type?: string;
        channel?: {
          alternatives?: Array<{ transcript?: string; confidence?: number }>;
        };
        is_final?: boolean;
        speech_final?: boolean;
      };

      if (data.type === 'Results') {
        const transcript = data.channel?.alternatives?.[0]?.transcript ?? '';
        const isFinal = data.is_final === true;
        const speechFinal = data.speech_final === true;

        if (transcript) {
          // Broadcast transcript to ALL connected clients with speaker identification
          broadcastJson(room, {
            type: 'transcript',
            speaker: 'user',
            partnerRole: conn.partnerRole,
            partnerName: conn.partnerName,
            text: transcript,
            isFinal,
            speechFinal,
          });
        }

        if (isFinal && transcript.trim()) {
          room.utteranceBuffer += (room.utteranceBuffer ? ' ' : '') + transcript.trim();
          room.utteranceBufferSpeaker = conn.partnerName;
        }

        if (speechFinal) {
          flushUtteranceBuffer();
        }
      }

      if (data.type === 'UtteranceEnd') {
        flushUtteranceBuffer();
      }
    } catch (error) {
      console.warn('[voice-ws] Failed to parse Deepgram STT message:', error);
    }
  });

  sttWs.on('error', (error) => {
    console.error('[voice-ws] Deepgram STT error:', error);
    sendJson(conn.ws, { type: 'error', message: 'Speech recognition connection error.' });
  });

  sttWs.on('close', (code, reason) => {
    console.info(`[voice-ws] Deepgram STT closed for ${conn.partnerName}: ${code} ${reason.toString()}`);
    conn.deepgramStt = null;

    if (!conn.closed && !room.closed) {
      setTimeout(() => {
        if (!conn.closed && !room.closed) {
          console.info(`[voice-ws] Reconnecting Deepgram STT for ${conn.partnerName}...`);
          connectDeepgramSTT(room, conn);
        }
      }, 1000);
    }
  });
};

/* ------------------------------------------------------------------ */
/*  Process a user's utterance through the LLM                        */
/* ------------------------------------------------------------------ */

const processUserUtterance = async (
  room: SessionRoom,
  text: string,
  speakerName: string,
  speakerRole: 'partner_a' | 'partner_b',
): Promise<void> => {
  if (room.closed || !text.trim()) return;

  // Wait for any current processing to finish
  while (room.isProcessing && !room.closed) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (room.closed) return;

  room.isProcessing = true;
  room.interrupted = false;

  const abortController = new AbortController();
  room.currentAbortController = abortController;

  try {
    // --- Real-time honesty analysis ---
    const analysis = analyzeUtterance(room, text, speakerName);

    room.honestyScore = clampScore(room.honestyScore + analysis.honestyDelta, 1, 100);
    room.escalationLevel = clampScore(room.escalationLevel + analysis.escalationDelta, 0, 100);
    persistRoomHonesty(room);

    // Broadcast honesty/escalation updates to all clients
    broadcastJson(room, {
      type: 'honesty_update',
      honestyScore: room.honestyScore,
      escalationLevel: room.escalationLevel,
      detectedPatterns: analysis.detectedPatterns,
    });

    // Record and broadcast intervention if detected
    if (analysis.intervention) {
      room.interventionCount += 1;
      const interventionEvent = {
        id: randomUUID(),
        stage: analysis.detectedPatterns.includes('ai_attack') ? 'mirror' as const
          : analysis.detectedPatterns.includes('denial') ? 'quote_evidence' as const
          : 'interrupt' as const,
        severity: analysis.intervention.severity,
        reason: analysis.intervention.reason,
        line: analysis.intervention.line,
        prompt: '',
        createdAt: new Date(),
      };

      broadcastJson(room, {
        type: 'intervention',
        intervention: interventionEvent,
      });

      // Save intervention to DB
      void SessionModel.findByIdAndUpdate(room.sessionId, {
        $push: { interventions: interventionEvent },
        $inc: { 'metrics.interventionCount': 1 },
      });
    }

    // Track recent turns for circular arguing detection
    room.recentUserTurns.push({ speaker: speakerName, text, timestamp: Date.now() });
    if (room.recentUserTurns.length > 12) {
      room.recentUserTurns = room.recentUserTurns.slice(-12);
    }

    // Save user transcript to database
    void saveTranscript(room.sessionId, {
      speakerRole,
      speakerLabel: speakerName,
      text,
      source: 'livekit-user',
    });

    // Add to chat with speaker prefix so LLM knows who is talking
    const prefixedText = `[${speakerName}]: ${text}`;
    room.chatHistory.push({ role: 'user', content: prefixedText });

    // Inject intervention context if the AI needs to intervene
    if (analysis.intervention) {
      room.chatHistory.push({
        role: 'system',
        content: `INTERVENTION REQUIRED: You detected ${analysis.detectedPatterns.join(', ')} from ${speakerName}. Your escalation level is now ${room.escalationLevel}/100. ${analysis.intervention.line} Address this directly and firmly.`,
      });
    }

    // Keep conversation history manageable
    while (room.chatHistory.length > 30) {
      const systemMsgs = room.chatHistory.filter((m) => m.role === 'system');
      const nonSystem = room.chatHistory.filter((m) => m.role !== 'system');
      room.chatHistory = [...systemMsgs.slice(0, 2), ...nonSystem.slice(-24)];
    }

    if (!env.OPENROUTER_API_KEY) {
      console.error('[voice-ws] OPENROUTER_API_KEY is not set.');
      broadcastJson(room, { type: 'error', message: 'OpenRouter API key is not configured.' });
      return;
    }

    const client = createOpenRouterClient({
      defaultMaxTokens: LLM_MAX_TOKENS,
    });

    broadcastJson(room, { type: 'status', status: 'thinking' });

    let stream: Awaited<ReturnType<typeof client.chat.completions.create>> | null = null;
    let lastModelError: unknown = null;

    for (const attempt of getModelAttemptOrder(room.selectedModel)) {
      try {
        stream = await client.chat.completions.create(
          {
            model: attempt.id,
            messages: room.chatHistory,
            max_tokens: LLM_MAX_TOKENS,
            temperature: LLM_TEMPERATURE,
            stream: true,
          },
          { signal: abortController.signal },
        );
        break;
      } catch (error) {
        lastModelError = error;
        console.warn(`[voice-ws] Model attempt failed for ${attempt.id} in session ${room.sessionId}.`, error);
      }
    }

    if (!stream) {
      throw lastModelError ?? new Error('No OpenRouter model could start a streamed response.');
    }

    let fullResponse = '';
    let sentenceBuffer = '';

    for await (const chunk of stream) {
      if (room.interrupted || room.closed || abortController.signal.aborted) {
        break;
      }

      const delta = chunk.choices?.[0]?.delta?.content ?? '';
      if (!delta) continue;

      fullResponse += delta;
      sentenceBuffer += delta;

      // Send complete sentences to TTS incrementally
      const sentenceEndMatch = sentenceBuffer.match(/^([\s\S]*?[.!?])\s+([\s\S]*)$/);
      if (sentenceEndMatch) {
        const completeSentence = sentenceEndMatch[1].trim();
        sentenceBuffer = sentenceEndMatch[2];

        if (completeSentence && !room.interrupted && !room.closed) {
          broadcastJson(room, {
            type: 'transcript',
            speaker: 'mirror',
            partnerRole: 'mirror',
            partnerName: 'Mirror',
            text: completeSentence,
            isFinal: true,
            speechFinal: false,
          });
          await synthesizeAndBroadcast(room, completeSentence, abortController);
        }
      }
    }

    // Process remaining text
    if (sentenceBuffer.trim() && !room.interrupted && !room.closed) {
      broadcastJson(room, {
        type: 'transcript',
        speaker: 'mirror',
        partnerRole: 'mirror',
        partnerName: 'Mirror',
        text: sentenceBuffer.trim(),
        isFinal: true,
        speechFinal: true,
      });
      await synthesizeAndBroadcast(room, sentenceBuffer.trim(), abortController);
    }

    if (!room.closed) {
      broadcastJson(room, { type: 'response_end' });
    }

    // Save assistant response
    if (fullResponse.trim()) {
      room.chatHistory.push({ role: 'assistant', content: fullResponse });

      void saveTranscript(room.sessionId, {
        speakerRole: 'mirror',
        speakerLabel: 'Mirror',
        text: fullResponse.trim(),
        source: 'agent-livekit',
      });

      persistRoomHonesty(room);
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      console.info(`[voice-ws] LLM response interrupted for session ${room.sessionId}`);
    } else {
      console.error('[voice-ws] LLM processing error:', error);
      broadcastJson(room, {
        type: 'error',
        message: 'Mirror could not reach the selected voice model. Try reconnecting or switching the session model.',
      });
    }
  } finally {
    room.isProcessing = false;
    room.currentAbortController = null;
  }
};

/* ------------------------------------------------------------------ */
/*  TTS synthesis and broadcast to all connected partners              */
/* ------------------------------------------------------------------ */

const synthesizeAndBroadcast = async (
  room: SessionRoom,
  text: string,
  abortController: AbortController,
): Promise<void> => {
  if (room.closed || room.interrupted || !text.trim()) return;
  if (!env.DEEPGRAM_API_KEY) return;

  room.isSpeaking = true;

  try {
    const ttsResponse = await fetch(DEEPGRAM_TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
      signal: abortController.signal,
    });

    if (!ttsResponse.ok) {
      const errorText = await ttsResponse.text().catch(() => '');
      console.error(`[voice-ws] Deepgram TTS error: ${ttsResponse.status} ${errorText}`);
      return;
    }

    const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());

    if (room.closed || room.interrupted) return;

    // Send audio to ALL connected partners
    broadcastJson(room, { type: 'audio_start', text });
    broadcastBinary(room, audioBuffer);
    broadcastJson(room, { type: 'audio_end' });
  } catch (error) {
    if (abortController.signal.aborted) return;
    console.error('[voice-ws] TTS synthesis error:', error);
  } finally {
    room.isSpeaking = false;
  }
};

/* ------------------------------------------------------------------ */
/*  Transcript persistence                                             */
/* ------------------------------------------------------------------ */

const saveTranscript = async (
  sessionId: string,
  segment: {
    speakerRole: string;
    speakerLabel: string;
    text: string;
    source: string;
  },
): Promise<void> => {
  try {
    const isAssistant = segment.speakerRole === 'mirror';

    await SessionModel.findByIdAndUpdate(sessionId, {
      $push: {
        transcriptSegments: {
          speakerUserId: null,
          speakerRole: segment.speakerRole,
          speakerLabel: segment.speakerLabel,
          text: segment.text,
          createdAt: new Date(),
          source: segment.source,
          tags: ['voice-ws'],
        },
      },
      $inc: {
        [isAssistant ? 'metrics.agentTranscriptCount' : 'metrics.localTranscriptCount']: 1,
      },
      $set: { status: 'live' },
    });
  } catch (error) {
    console.warn('[voice-ws] Failed to save transcript:', error);
  }
};

/* ------------------------------------------------------------------ */
/*  Get or create a session room                                       */
/* ------------------------------------------------------------------ */

const getOrCreateRoom = async (sessionId: string): Promise<SessionRoom | null> => {
  if (activeRooms.has(sessionId)) {
    return activeRooms.get(sessionId)!;
  }

  // Load session and couple from DB
  const sessionDoc = await SessionModel.findById(sessionId);
  if (!sessionDoc) return null;

  const couple = await CoupleModel.findById(sessionDoc.coupleId);
  if (!couple) return null;

  const partnerAName = couple.partnerAName || 'Partner A';
  const partnerBName = couple.partnerBName || 'Partner B';

  // Build homework context from couple data (current reflections to discuss)
  const homeworkReflections = buildHomeworkContext(couple);

  // Build full reflection history from vector memory (ALL past reflections)
  const coupleIdStr = String(sessionDoc.coupleId);
  const fullReflectionHistory = await buildFullReflectionContext(couple, coupleIdStr);

  // Build opening context from session data (now enriched with memory)
  const openingContext = sessionDoc.openingContext || '';

  // Determine if there are reflections to discuss
  const hasReflections = homeworkReflections.length > 0;
  const reflectionOpeningLine = hasReflections
    ? MemoryApplication.buildReflectionOpeningLine(couple)
    : '';
  const initialHonestyScore =
    typeof sessionDoc.metrics?.honestyScore === 'number' && sessionDoc.metrics.honestyScore > 0
      ? sessionDoc.metrics.honestyScore
      : 50;

  const room: SessionRoom = {
    sessionId,
    coupleId: coupleIdStr,
    chatHistory: [],
    connections: new Map(),
    isProcessing: false,
    isSpeaking: false,
    interrupted: false,
    currentAbortController: null,
    utteranceBuffer: '',
    utteranceBufferSpeaker: '',
    honestyScore: initialHonestyScore,
    escalationLevel: 25,
    interventionCount: sessionDoc.metrics?.interventionCount || 0,
    recentUserTurns: [],
    selectedModel: sessionDoc.selectedModel,
    partnerAName,
    partnerBName,
    couple,
    openingContext,
    homeworkReflections,
    fullReflectionHistory,
    reflectionOpeningLine,
    hasReflections,
    sessionStarted: false,
    reflectionKickoffDelivered: false,
    closed: false,
  };

  // Build system prompt with full context
  room.chatHistory = [{ role: 'system', content: buildSystemPrompt(room) }];

  activeRooms.set(sessionId, room);

  // Mark session as live
  await SessionModel.findByIdAndUpdate(sessionId, {
    $set: {
      status: 'live',
      startedAt: sessionDoc.startedAt ?? new Date(),
    },
  });

  return room;
};

/* ------------------------------------------------------------------ */
/*  Resolve which partner is connecting                                */
/* ------------------------------------------------------------------ */

const resolvePartner = (
  couple: CoupleDocument,
  userId: string,
): { role: 'partner_a' | 'partner_b'; name: string } | null => {
  if (couple.partnerAUserId === userId) {
    return { role: 'partner_a', name: couple.partnerAName };
  }
  if (couple.partnerBUserId === userId) {
    return { role: 'partner_b', name: couple.partnerBName || 'Partner B' };
  }
  // If no userId match, assign based on which slot is open
  // This handles demo mode or cases where userId isn't validated
  return null;
};

/* ------------------------------------------------------------------ */
/*  WebSocket server attachment                                        */
/* ------------------------------------------------------------------ */

export const attachVoiceWebSocket = (server: Server): void => {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);

    if (url.pathname !== '/api/voice') {
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    void handleVoiceConnection(ws, request);
  });

  markVoiceWebSocketAttached();
  console.info('[voice-ws] WebSocket voice pipeline attached at /api/voice');
};

/* ------------------------------------------------------------------ */
/*  Handle incoming WebSocket connection                               */
/* ------------------------------------------------------------------ */

const handleVoiceConnection = async (ws: WebSocket, request: IncomingMessage): Promise<void> => {
  const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
  const sessionId = url.searchParams.get('sessionId');
  const userId = url.searchParams.get('userId') || '';

  if (!sessionId) {
    sendJson(ws, { type: 'error', message: 'Missing sessionId parameter.' });
    ws.close(4000, 'Missing sessionId');
    return;
  }

  // Get or create the session room
  const room = await getOrCreateRoom(sessionId);
  if (!room) {
    sendJson(ws, { type: 'error', message: 'Session not found.' });
    ws.close(4004, 'Session not found');
    return;
  }

  // Resolve partner identity
  let partnerRole: 'partner_a' | 'partner_b' = 'partner_a';
  let partnerName = room.partnerAName;

  if (room.couple && userId) {
    const resolved = resolvePartner(room.couple, userId);
    if (resolved) {
      partnerRole = resolved.role;
      partnerName = resolved.name;
    } else {
      // Fallback: assign to whichever slot doesn't have an active connection
      const hasPartnerA = Array.from(room.connections.values()).some((c) => c.partnerRole === 'partner_a' && !c.closed);
      if (hasPartnerA) {
        partnerRole = 'partner_b';
        partnerName = room.partnerBName;
      }
    }
  } else {
    // No userId: assign based on connection order
    const hasPartnerA = Array.from(room.connections.values()).some((c) => c.partnerRole === 'partner_a' && !c.closed);
    if (hasPartnerA) {
      partnerRole = 'partner_b';
      partnerName = room.partnerBName;
    }
  }

  const visitorId = `${userId || 'anon'}-${Date.now()}`;
  const conn: VoiceConnection = {
    userId,
    partnerRole,
    partnerName,
    ws,
    deepgramStt: null,
    closed: false,
  };

  room.connections.set(visitorId, conn);

  console.info(`[voice-ws] ${partnerName} (${partnerRole}) joined session ${sessionId}`);
  sendJson(ws, {
    type: 'connected',
    sessionId,
    partnerName,
    partnerRole,
    honestyScore: room.honestyScore,
    escalationLevel: room.escalationLevel,
  });

  // Notify all other connections that a new partner joined
  for (const [id, otherConn] of room.connections) {
    if (id !== visitorId && !otherConn.closed) {
      sendJson(otherConn.ws, {
        type: 'partner_joined',
        partnerRole,
        partnerName,
      });
    }
  }

  // Connect to Deepgram STT for this partner
  connectDeepgramSTT(room, conn);

  // Deliver opening greeting after a short delay
  setTimeout(() => {
    if (conn.closed || room.closed) return;

    // Only greet once when the first partner connects, or when second partner joins
    const activeConnections = Array.from(room.connections.values()).filter((c) => !c.closed);

    if (!room.sessionStarted) {
      const greeting = buildOpeningGreeting(room, activeConnections);
      room.chatHistory.push({ role: 'assistant', content: greeting });
      room.sessionStarted = true;
      if (room.hasReflections && activeConnections.length >= 2) {
        queueReflectionKickoff(room);
      }

      broadcastJson(room, {
        type: 'transcript',
        speaker: 'mirror',
        partnerRole: 'mirror',
        partnerName: 'Mirror',
        text: greeting,
        isFinal: true,
        speechFinal: true,
      });
      void synthesizeAndBroadcast(room, greeting, new AbortController());
      broadcastJson(room, { type: 'response_end' });
      return;
    }

    if (activeConnections.length === 2 && !room.reflectionKickoffDelivered) {
      const secondPartner = { partnerName };
      const joinAnnouncement = room.hasReflections
        ? `Good. Both of you are here now. ${room.reflectionOpeningLine}`
            : `${secondPartner.partnerName} has joined. Good. Now we can work. Let me be clear — I see both of you and I will hold both of you accountable equally.`;

          setTimeout(() => {
            if (room.closed) return;
            room.chatHistory.push({ role: 'assistant', content: joinAnnouncement });
            broadcastJson(room, {
              type: 'transcript',
              speaker: 'mirror',
              partnerRole: 'mirror',
              partnerName: 'Mirror',
              text: joinAnnouncement,
              isFinal: true,
              speechFinal: true,
            });
            void synthesizeAndBroadcast(room, joinAnnouncement, new AbortController());

            queueReflectionKickoff(room);
      }, 1800);
    }
  }, 1500);

  // Handle incoming messages from this partner's browser
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (conn.closed || room.closed) return;

    if (isBinary) {
      // Binary = audio data from microphone, forward to this partner's Deepgram STT
      if (conn.deepgramStt?.readyState === WebSocket.OPEN) {
        conn.deepgramStt.send(data);
      }
    } else {
      // JSON control messages
      try {
        const msg = JSON.parse(data.toString()) as { type: string };

        if (msg.type === 'interrupt') {
          room.interrupted = true;
          room.currentAbortController?.abort();
          broadcastJson(room, { type: 'interrupt' });
        } else if (msg.type === 'ping') {
          sendJson(ws, { type: 'pong' });
        }
      } catch {
        // Ignore malformed messages
      }
    }
  });

  ws.on('close', () => {
    conn.closed = true;
    room.connections.delete(visitorId);

    // Close this partner's Deepgram STT
    if (conn.deepgramStt?.readyState === WebSocket.OPEN) {
      conn.deepgramStt.send(JSON.stringify({ type: 'CloseStream' }));
      conn.deepgramStt.close();
    }

    // Notify remaining partners
    for (const otherConn of room.connections.values()) {
      if (!otherConn.closed) {
        sendJson(otherConn.ws, {
          type: 'partner_left',
          partnerRole,
          partnerName,
        });
      }
    }

    // If no connections left, abort processing and clean up room
    const activeConns = Array.from(room.connections.values()).filter((c) => !c.closed);
    if (activeConns.length === 0) {
      room.closed = true;
      room.currentAbortController?.abort();
      activeRooms.delete(sessionId);
      console.info(`[voice-ws] Session room closed: ${sessionId}`);
    } else {
      console.info(`[voice-ws] ${partnerName} left session ${sessionId}. ${activeConns.length} partner(s) remaining.`);
    }
  });

  ws.on('error', (error) => {
    console.error(`[voice-ws] WebSocket error for ${partnerName} in session ${sessionId}:`, error);
    conn.closed = true;
  });
};
