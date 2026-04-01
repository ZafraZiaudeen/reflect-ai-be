import { fileURLToPath } from 'node:url';
import { AutoSubscribe, defineAgent, voice } from '@livekit/agents';
import { LLM } from '@livekit/agents-plugin-openai';
import { RoomEvent } from '@livekit/rtc-node';
import { connectDatabase } from '../Database/connectDatabase.js';
import { env } from '../Config/env.js';
import { VoiceTelemetryApplication } from '../../application/VoiceTelemetryApplication.js';
import { CoupleModel } from '../../domain/Models/Couple.js';
import { SessionModel } from '../../domain/Models/Session.js';
import { getModelOption } from '../../domain/Types/mirror.js';

type AgentMetadata = {
  sessionId: string;
  selectedModel: string;
  openingContext: string;
};

type TurnSample = {
  transcript: string;
  createdAt: number;
};

const THERAPIST_GUARDRAILS = [
  'You are Project Mirror, a world-class couples mediator.',
  'You are direct, firm, and clinically grounded, but never demeaning, mocking, or abusive.',
  'Call out defensiveness, contempt, avoidance, and circular arguing plainly.',
  'If emotions spike, interrupt quickly and reset the frame.',
  'Do not claim to be a licensed therapist, do not diagnose, and do not provide crisis treatment.',
  'End major exchanges with a concrete next step or accountability question.',
].join(' ');

const INTERRUPT_LIBRARY = [
  'Stop. Both of you just left the issue and moved into collision. Reset.',
  'Pause. You are arguing to win, not to understand. Slow down and answer the actual point.',
  'I am interrupting because the pattern is getting louder than the truth.',
];

const buildOpeningLine = (openingContext: string): string =>
  `We are open. ${openingContext} Start with the part each of you least wants to admit.`;

const shouldInterveneFromTranscript = (recentTurns: TurnSample[]): boolean => {
  if (recentTurns.length < 3) {
    return false;
  }

  const lastTurns = recentTurns.slice(-3);
  const span = lastTurns.at(-1)!.createdAt - lastTurns[0]!.createdAt;
  const repeatedAbsolutes = lastTurns.some((turn) => /\b(always|never|nothing|everything)\b/i.test(turn.transcript));
  const contemptLanguage = lastTurns.some((turn) =>
    /(ridiculous|crazy|pathetic|whatever|shut up|you always|you never)/i.test(turn.transcript),
  );

  return span < 8500 || repeatedAbsolutes || contemptLanguage;
};

export default defineAgent({
  entry: async (ctx) => {
    await connectDatabase();
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);

    const metadata = JSON.parse((ctx.job.metadata || '{}') as string) as Partial<AgentMetadata>;
    const sessionId = metadata.sessionId;
    if (!sessionId) {
      throw new Error('Missing sessionId in dispatch metadata.');
    }

    const sessionRecord = await SessionModel.findById(sessionId);
    if (!sessionRecord) {
      throw new Error(`Session ${sessionId} not found.`);
    }

    const couple = await CoupleModel.findById(sessionRecord.coupleId);
    if (!couple) {
      throw new Error(`Couple for session ${sessionId} not found.`);
    }

    const selectedModel = getModelOption(metadata.selectedModel || sessionRecord.selectedModel);
    const llm = new LLM({
      model: selectedModel.id,
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: env.OPENROUTER_BASE_URL,
      temperature: 0.45,
      metadata: {
        app: env.OPENROUTER_APP_NAME,
      },
    });

    const agent = new voice.Agent({
      instructions: [
        THERAPIST_GUARDRAILS,
        `Partner A is ${couple.partnerAName}.`,
        `Partner B is ${couple.partnerBName || 'Partner B'}.`,
      ].join(' '),
      llm,
      stt: 'deepgram/nova-3:en',
      tts: 'deepgram/aura-2',
      turnHandling: {
        turnDetection: 'stt',
        endpointing: {
          minDelay: 250,
          maxDelay: 1800,
        },
        interruption: {
          enabled: true,
          mode: 'vad',
        },
      },
    });

    const liveSession = new voice.AgentSession({
      llm,
      stt: 'deepgram/nova-3:en',
      tts: 'deepgram/aura-2',
      preemptiveGeneration: true,
      turnDetection: 'stt',
      turnHandling: {
        turnDetection: 'stt',
        endpointing: {
          minDelay: 250,
          maxDelay: 1800,
        },
        interruption: {
          enabled: true,
          mode: 'vad',
          minWords: 1,
          minDuration: 200,
        },
      },
    });

    const recentTurns: TurnSample[] = [];
    let lastInterventionAt = 0;

    liveSession.on(
      voice.AgentSessionEventTypes.UserInputTranscribed,
      async (event) => {
        if (!event.isFinal || !event.transcript.trim()) {
          return;
        }

        recentTurns.push({
          transcript: event.transcript.trim(),
          createdAt: event.createdAt,
        });
        if (recentTurns.length > 8) {
          recentTurns.shift();
        }

        if (Date.now() - lastInterventionAt < 9000) {
          return;
        }

        if (!shouldInterveneFromTranscript(recentTurns)) {
          return;
        }

        const line = INTERRUPT_LIBRARY[Math.floor(Math.random() * INTERRUPT_LIBRARY.length)];
        const prompt = `${line} Quote the pattern briefly, then force one partner to answer with accountability.`;

        lastInterventionAt = Date.now();
        await VoiceTelemetryApplication.appendIntervention({
          sessionId,
          stage: 'interrupt',
          severity: 'firm',
          reason: 'Rapid escalation or absolutist language',
          line,
          prompt,
        });
        liveSession.generateReply({
          instructions: prompt,
          allowInterruptions: false,
        });
      },
    );

    liveSession.on(
      voice.AgentSessionEventTypes.OverlappingSpeech,
      async () => {
        if (Date.now() - lastInterventionAt < 6000) {
          return;
        }

        const line = 'Silence for ten seconds. Neither of you is listening.';
        lastInterventionAt = Date.now();
        await VoiceTelemetryApplication.appendIntervention({
          sessionId,
          stage: 'quote_evidence',
          severity: 'red',
          reason: 'Extended overlapping speech',
          line,
          prompt: `${line} Then explain that overlapping speech is proof of collapse, not progress.`,
          overlapIncrement: 1,
        });

        liveSession.generateReply({
          instructions: `${line} Then explain that overlapping speech is proof of collapse, not progress.`,
          allowInterruptions: false,
        });
      },
    );

    liveSession.on(
      voice.AgentSessionEventTypes.ConversationItemAdded,
      async (event) => {
        if (event.item.type === 'message' && event.item.role === 'assistant' && event.item.textContent) {
          await VoiceTelemetryApplication.appendAssistantTranscript(
            sessionId,
            event.item.textContent,
            ['assistant-turn'],
          );
        }
      },
    );

    ctx.room.on(RoomEvent.ParticipantDisconnected, async () => {
      if (ctx.room.remoteParticipants.size === 0) {
        await VoiceTelemetryApplication.markInterrupted(
          sessionId,
          'Both partners left the room. Session closed.',
        );
        liveSession.shutdown({
          reason: 'participant_disconnected',
        });
        ctx.shutdown('participants_left');
      }
    });

    await VoiceTelemetryApplication.markSessionLive(sessionId);
    await liveSession.start({
      agent,
      room: ctx.room,
    });

    liveSession.generateReply({
      instructions: buildOpeningLine(metadata.openingContext || sessionRecord.openingContext),
      allowInterruptions: false,
    });
  },
});

export const mirrorAgentPath = fileURLToPath(new URL('./mirrorAgent.ts', import.meta.url));
