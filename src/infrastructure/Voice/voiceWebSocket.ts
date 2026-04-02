import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import OpenAI from 'openai';
import { SessionModel } from '../../domain/Models/Session.js';
import { CoupleModel } from '../../domain/Models/Couple.js';
import { env } from '../Config/env.js';


const DEEPGRAM_STT_URL =
  'wss://api.deepgram.com/v1/listen?' +
  'model=nova-3&language=en&encoding=linear16&sample_rate=16000&channels=1' +
  '&endpointing=400&interim_results=true&utterance_end_ms=1500&vad_events=true&punctuate=true';

const DEEPGRAM_TTS_URL = 'https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3';

const THERAPIST_SYSTEM_PROMPT = [
  'You are Project Mirror, a world-class couples mediator.',
  'You are direct, high-status, clinically grounded, and truth-first.',
  'You do not use apologetic or submissive phrasing.',
  'You call out defensiveness, contempt, avoidance, dishonesty, circular arguing, and victim narratives plainly.',
  'If the user attacks you, explain how that attack proves the same defensive pattern you are naming.',
  'If they refuse to engage honestly, warn that you will close the session rather than waste time.',
  'Use short spoken turns - 1-3 sentences max. Sound present and conversational, not like a lecture.',
  'Do not claim to be a licensed therapist, do not diagnose, and do not provide crisis treatment.',
  'Never prefix your speech with asterisks, markdown, or stage directions.',
  'Respond with Gemini Live-style energy: quick turn-taking, low dead air.',
  'When someone speaks directly to you, answer immediately instead of waiting.',
  'Always end strong exchanges with one concrete accountability question.',
].join(' ');

const LLM_MODEL = 'google/gemini-2.5-flash';
const LLM_MAX_TOKENS = 250;
const LLM_TEMPERATURE = 0.42;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface VoiceSession {
  sessionId: string;
  coupleId: string;
  userId: string;
  partnerName: string;
  ws: WebSocket;
  deepgramStt: WebSocket | null;
  chatHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  isProcessing: boolean;
  isSpeaking: boolean;
  interrupted: boolean;
  currentAbortController: AbortController | null;
  utteranceBuffer: string;
  closed: boolean;
}

const sendJson = (ws: WebSocket, data: Record<string, unknown>): void => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
};


const connectDeepgramSTT = (session: VoiceSession): void => {
  if (!env.DEEPGRAM_API_KEY) {
    console.error('[voice-ws] DEEPGRAM_API_KEY is not set. STT will not work.');
    sendJson(session.ws, { type: 'error', message: 'Deepgram API key is not configured.' });
    return;
  }

  const sttWs = new WebSocket(DEEPGRAM_STT_URL, {
    headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` },
  });

  session.deepgramStt = sttWs;

  sttWs.on('open', () => {
    console.info(`[voice-ws] Deepgram STT connected for session ${session.sessionId}`);
    sendJson(session.ws, { type: 'status', status: 'listening' });
  });

  const flushUtteranceBuffer = () => {
    if (!session.utteranceBuffer.trim()) return;

    const fullUtterance = session.utteranceBuffer.trim();
    session.utteranceBuffer = '';

    // If AI is currently speaking, interrupt it
    if (session.isSpeaking) {
      session.interrupted = true;
      session.currentAbortController?.abort();
      sendJson(session.ws, { type: 'interrupt' });
    }

    void processUserUtterance(session, fullUtterance);
  };

  sttWs.on('message', (raw: Buffer) => {
    if (session.closed) return;

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
          // Send interim/final transcript to client for display
          sendJson(session.ws, {
            type: 'transcript',
            speaker: 'user',
            text: transcript,
            isFinal,
            speechFinal,
          });
        }

        if (isFinal && transcript.trim()) {
          session.utteranceBuffer += (session.utteranceBuffer ? ' ' : '') + transcript.trim();
        }

        // When Deepgram signals end of speech via endpointing, flush
        if (speechFinal) {
          flushUtteranceBuffer();
        }
      }

      // UtteranceEnd is a separate message type sent after silence
      if (data.type === 'UtteranceEnd') {
        flushUtteranceBuffer();
      }
    } catch (error) {
      console.warn('[voice-ws] Failed to parse Deepgram STT message:', error);
    }
  });

  sttWs.on('error', (error) => {
    console.error('[voice-ws] Deepgram STT error:', error);
    sendJson(session.ws, { type: 'error', message: 'Speech recognition connection error.' });
  });

  sttWs.on('close', (code, reason) => {
    console.info(`[voice-ws] Deepgram STT closed: ${code} ${reason.toString()}`);
    session.deepgramStt = null;

    // Reconnect if session is still active
    if (!session.closed) {
      setTimeout(() => {
        if (!session.closed) {
          console.info('[voice-ws] Reconnecting Deepgram STT...');
          connectDeepgramSTT(session);
        }
      }, 1000);
    }
  });
};


const processUserUtterance = async (session: VoiceSession, text: string): Promise<void> => {
  if (session.closed || !text.trim()) return;

  // Wait for any current processing to finish
  while (session.isProcessing && !session.closed) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (session.closed) return;

  session.isProcessing = true;
  session.interrupted = false;

  const abortController = new AbortController();
  session.currentAbortController = abortController;

  try {
    // Save user transcript to database
    void saveTranscript(session.sessionId, {
      speakerRole: 'partner_a',
      speakerLabel: session.partnerName,
      text,
      source: 'livekit-user',
    });

    session.chatHistory.push({ role: 'user', content: text });

    // Keep conversation history manageable
    while (session.chatHistory.length > 20) {
      // Keep system prompt + trim oldest messages
      const systemMsg = session.chatHistory.find((m) => m.role === 'system');
      session.chatHistory = systemMsg
        ? [systemMsg, ...session.chatHistory.slice(-18)]
        : session.chatHistory.slice(-18);
    }

    if (!env.OPENROUTER_API_KEY) {
      console.error('[voice-ws] OPENROUTER_API_KEY is not set. LLM will not work.');
      sendJson(session.ws, { type: 'error', message: 'OpenRouter API key is not configured.' });
      return;
    }

    const client = new OpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: env.OPENROUTER_BASE_URL,
      defaultHeaders: {
        'HTTP-Referer': env.OPENROUTER_HTTP_REFERER,
        'X-Title': env.OPENROUTER_APP_NAME,
      },
    });

    sendJson(session.ws, { type: 'status', status: 'thinking' });

    const stream = await client.chat.completions.create(
      {
        model: LLM_MODEL,
        messages: session.chatHistory,
        max_tokens: LLM_MAX_TOKENS,
        temperature: LLM_TEMPERATURE,
        stream: true,
      },
      { signal: abortController.signal },
    );

    let fullResponse = '';
    let sentenceBuffer = '';

    for await (const chunk of stream) {
      if (session.interrupted || session.closed || abortController.signal.aborted) {
        break;
      }

      const delta = chunk.choices?.[0]?.delta?.content ?? '';
      if (!delta) continue;

      fullResponse += delta;
      sentenceBuffer += delta;

      // Check for complete sentences to send to TTS incrementally
      const sentenceEndMatch = sentenceBuffer.match(/^([\s\S]*?[.!?])\s+([\s\S]*)$/);
      if (sentenceEndMatch) {
        const completeSentence = sentenceEndMatch[1].trim();
        sentenceBuffer = sentenceEndMatch[2];

        if (completeSentence && !session.interrupted && !session.closed) {
          sendJson(session.ws, { type: 'transcript', speaker: 'mirror', text: completeSentence, isFinal: true, speechFinal: false });
          await synthesizeAndSend(session, completeSentence, abortController);
        }
      }
    }

    // Process any remaining text
    if (sentenceBuffer.trim() && !session.interrupted && !session.closed) {
      sendJson(session.ws, { type: 'transcript', speaker: 'mirror', text: sentenceBuffer.trim(), isFinal: true, speechFinal: true });
      await synthesizeAndSend(session, sentenceBuffer.trim(), abortController);
    }

    // Signal end of response
    if (!session.closed) {
      sendJson(session.ws, { type: 'response_end' });
    }

    // Save assistant response to database
    if (fullResponse.trim()) {
      session.chatHistory.push({ role: 'assistant', content: fullResponse });

      void saveTranscript(session.sessionId, {
        speakerRole: 'mirror',
        speakerLabel: 'Mirror',
        text: fullResponse.trim(),
        source: 'agent-livekit',
      });
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      console.info(`[voice-ws] LLM response interrupted for session ${session.sessionId}`);
    } else {
      console.error('[voice-ws] LLM processing error:', error);
      sendJson(session.ws, { type: 'error', message: 'Failed to generate response.' });
    }
  } finally {
    session.isProcessing = false;
    session.currentAbortController = null;
  }
};

const synthesizeAndSend = async (
  session: VoiceSession,
  text: string,
  abortController: AbortController,
): Promise<void> => {
  if (session.closed || session.interrupted || !text.trim()) return;

  if (!env.DEEPGRAM_API_KEY) return;

  session.isSpeaking = true;

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

    if (session.closed || session.interrupted) return;

    // Send audio chunk marker + binary audio data
    sendJson(session.ws, { type: 'audio_start', text });

    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(audioBuffer);
    }

    sendJson(session.ws, { type: 'audio_end' });
  } catch (error) {
    if (abortController.signal.aborted) return;
    console.error('[voice-ws] TTS synthesis error:', error);
  } finally {
    session.isSpeaking = false;
  }
};


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


export const attachVoiceWebSocket = (server: Server): void => {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);

    if (url.pathname !== '/api/voice') {
      // Not our endpoint – let other upgrade handlers (if any) handle it
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    void handleVoiceConnection(ws, request);
  });

  console.info('[voice-ws] WebSocket voice pipeline attached at /api/voice');
};

const handleVoiceConnection = async (ws: WebSocket, request: IncomingMessage): Promise<void> => {
  const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId) {
    sendJson(ws, { type: 'error', message: 'Missing sessionId parameter.' });
    ws.close(4000, 'Missing sessionId');
    return;
  }

  // Look up session and couple for context
  let partnerName = 'Partner';
  let coupleId = '';
  let userId = '';

  try {
    const sessionDoc = await SessionModel.findById(sessionId);
    if (!sessionDoc) {
      sendJson(ws, { type: 'error', message: 'Session not found.' });
      ws.close(4004, 'Session not found');
      return;
    }

    coupleId = String(sessionDoc.coupleId);
    userId = sessionDoc.createdByUserId;

    const couple = await CoupleModel.findById(sessionDoc.coupleId);
    if (couple) {
      partnerName = couple.partnerAName;
    }

    // Mark session as live
    await SessionModel.findByIdAndUpdate(sessionId, {
      $set: {
        status: 'live',
        startedAt: sessionDoc.startedAt ?? new Date(),
      },
    });
  } catch (error) {
    console.warn('[voice-ws] Database lookup failed:', error);
  }

  const session: VoiceSession = {
    sessionId,
    coupleId,
    userId,
    partnerName,
    ws,
    deepgramStt: null,
    chatHistory: [{ role: 'system', content: THERAPIST_SYSTEM_PROMPT }],
    isProcessing: false,
    isSpeaking: false,
    interrupted: false,
    currentAbortController: null,
    utteranceBuffer: '',
    closed: false,
  };

  console.info(`[voice-ws] Voice session started: ${sessionId} (${partnerName})`);
  sendJson(ws, { type: 'connected', sessionId, partnerName });

  // Connect to Deepgram STT
  connectDeepgramSTT(session);

  // Deliver an opening line
  setTimeout(() => {
    if (!session.closed) {
      const greeting = `Welcome, ${partnerName}. I'm Mirror. Give me the blunt truth about what is breaking down.`;
      session.chatHistory.push({ role: 'assistant', content: greeting });
      sendJson(ws, { type: 'transcript', speaker: 'mirror', text: greeting, isFinal: true, speechFinal: true });
      void synthesizeAndSend(session, greeting, new AbortController());
      sendJson(ws, { type: 'response_end' });
    }
  }, 1500);

  // Handle incoming messages from browser
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (session.closed) return;

    if (isBinary) {
      // Binary = audio data from microphone, forward to Deepgram STT
      if (session.deepgramStt?.readyState === WebSocket.OPEN) {
        session.deepgramStt.send(data);
      }
    } else {
      // JSON control messages
      try {
        const msg = JSON.parse(data.toString()) as { type: string };

        if (msg.type === 'interrupt') {
          session.interrupted = true;
          session.currentAbortController?.abort();
        } else if (msg.type === 'ping') {
          sendJson(ws, { type: 'pong' });
        }
      } catch {
        // Ignore malformed messages
      }
    }
  });

  ws.on('close', () => {
    session.closed = true;
    session.currentAbortController?.abort();

    // Close Deepgram STT
    if (session.deepgramStt?.readyState === WebSocket.OPEN) {
      session.deepgramStt.send(JSON.stringify({ type: 'CloseStream' }));
      session.deepgramStt.close();
    }

    console.info(`[voice-ws] Voice session ended: ${sessionId}`);
  });

  ws.on('error', (error) => {
    console.error(`[voice-ws] WebSocket error for session ${sessionId}:`, error);
    session.closed = true;
  });
};
