import { randomUUID } from 'node:crypto';
import { SessionModel } from '../domain/Models/Session.js';
import type {
  InterventionSeverity,
  InterventionStage,
  SpeakerRole,
} from '../domain/Types/mirror.js';
import { connectDatabase } from '../infrastructure/Database/connectDatabase.js';

const runTelemetryMutation = async (
  label: string,
  mutation: () => Promise<unknown>,
): Promise<void> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await connectDatabase({ retries: 2 });
      await mutation();
      return;
    } catch (error) {
      if (attempt === 1) {
        console.warn(`Voice telemetry mutation failed for ${label}.`, error);
      }
    }
  }
};

export class VoiceTelemetryApplication {
  static async markSessionLive(sessionId: string): Promise<void> {
    await runTelemetryMutation('markSessionLive', async () => {
      const now = new Date();
      const startedAtUpdate = await SessionModel.updateOne(
        {
          _id: sessionId,
          startedAt: null,
        },
        {
          $set: {
            status: 'live',
            endedAt: null,
            startedAt: now,
          },
        },
      );

      if (startedAtUpdate.matchedCount === 0) {
        await SessionModel.findByIdAndUpdate(sessionId, {
          $set: {
            status: 'live',
            endedAt: null,
          },
        });
      }
    });
  }

  static async appendPartnerTranscript(args: {
    sessionId: string;
    speakerUserId?: string | null;
    speakerRole: SpeakerRole;
    speakerLabel: string;
    text: string;
    source: 'frontend-webspeech' | 'livekit-user';
    createdAt?: Date;
    startedAtMs?: number;
    endedAtMs?: number;
    confidence?: number;
    tags?: string[];
  }): Promise<void> {
    const normalizedText = args.text.trim();
    if (!normalizedText) {
      return;
    }

    await runTelemetryMutation('appendPartnerTranscript', async () => {
      await SessionModel.findByIdAndUpdate(args.sessionId, {
        $push: {
          transcriptSegments: {
            speakerUserId: args.speakerUserId ?? null,
            speakerRole: args.speakerRole,
            speakerLabel: args.speakerLabel,
            text: normalizedText,
            createdAt: args.createdAt ?? new Date(),
            startedAtMs: args.startedAtMs,
            endedAtMs: args.endedAtMs,
            confidence: args.confidence,
            source: args.source,
            tags: args.tags ?? [],
          },
        },
        $inc: {
          'metrics.localTranscriptCount': 1,
        },
        $set: {
          status: 'live',
        },
      });
    });
  }

  static async appendAssistantTranscript(
    sessionId: string,
    text: string,
    tags: string[] = [],
  ): Promise<void> {
    const normalizedText = text.trim();
    if (!normalizedText) {
      return;
    }

    await runTelemetryMutation('appendAssistantTranscript', async () => {
      await SessionModel.findByIdAndUpdate(sessionId, {
        $push: {
          transcriptSegments: {
            speakerUserId: null,
            speakerRole: 'mirror',
            speakerLabel: 'Mirror',
            text: normalizedText,
            createdAt: new Date(),
            source: 'agent-livekit',
            tags,
          },
        },
        $inc: {
          'metrics.agentTranscriptCount': 1,
        },
        $set: {
          status: 'live',
        },
      });
    });
  }

  static async appendIntervention(args: {
    sessionId: string;
    stage: InterventionStage;
    severity: InterventionSeverity;
    reason: string;
    line: string;
    prompt: string;
    overlapIncrement?: number;
  }): Promise<void> {
    await runTelemetryMutation('appendIntervention', async () => {
      await SessionModel.findByIdAndUpdate(args.sessionId, {
        $push: {
          interventions: {
            id: randomUUID(),
            stage: args.stage,
            severity: args.severity,
            reason: args.reason,
            line: args.line,
            prompt: args.prompt,
            createdAt: new Date(),
          },
        },
        $inc: {
          'metrics.interventionCount': 1,
          'metrics.overlapCount': args.overlapIncrement ?? 0,
        },
      });
    });
  }

  static async updateHonestyScore(sessionId: string, honestyScore: number): Promise<void> {
    const clampedScore = Math.max(1, Math.min(100, Math.round(honestyScore)));
    await runTelemetryMutation('updateHonestyScore', async () => {
      await SessionModel.findByIdAndUpdate(sessionId, {
        $set: {
          'metrics.honestyScore': clampedScore,
        },
      });
    });
  }

  static async markInterrupted(sessionId: string, reason: string): Promise<void> {
    await runTelemetryMutation('markInterrupted', async () => {
      await SessionModel.findByIdAndUpdate(sessionId, {
        $set: {
          status: 'interrupted',
          endedAt: new Date(),
          liveKitDispatchId: null,
          agentDispatchRequestedAt: null,
        },
        $push: {
          transcriptSegments: {
            speakerUserId: null,
            speakerRole: 'system',
            speakerLabel: 'System',
            text: reason,
            createdAt: new Date(),
            source: 'system',
            tags: ['session-shutdown'],
          },
        },
      });
    });
  }
}
