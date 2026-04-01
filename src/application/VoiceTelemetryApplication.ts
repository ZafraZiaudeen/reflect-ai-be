import { randomUUID } from 'node:crypto';
import { SessionModel } from '../domain/Models/Session.js';
import type {
  InterventionSeverity,
  InterventionStage,
} from '../domain/Types/mirror.js';

export class VoiceTelemetryApplication {
  static async markSessionLive(sessionId: string): Promise<void> {
    await SessionModel.findByIdAndUpdate(sessionId, {
      status: 'live',
      startedAt: new Date(),
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
  }

  static async markInterrupted(sessionId: string, reason: string): Promise<void> {
    await SessionModel.findByIdAndUpdate(sessionId, {
      status: 'interrupted',
      endedAt: new Date(),
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
  }
}
