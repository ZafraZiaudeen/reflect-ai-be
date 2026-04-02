import { Schema, model } from 'mongoose';
const TranscriptSegmentSchema = new Schema({
    speakerUserId: { type: String, default: null },
    speakerRole: { type: String, required: true },
    speakerLabel: { type: String, required: true },
    text: { type: String, required: true },
    createdAt: { type: Date, required: true },
    startedAtMs: { type: Number },
    endedAtMs: { type: Number },
    confidence: { type: Number },
    source: { type: String, required: true },
    tags: { type: [String], default: [] },
}, { _id: false });
const InterventionEventSchema = new Schema({
    id: { type: String, required: true },
    stage: { type: String, required: true },
    severity: { type: String, required: true },
    reason: { type: String, required: true },
    line: { type: String, required: true },
    prompt: { type: String, required: true },
    createdAt: { type: Date, required: true },
}, { _id: false });
const HomeworkAssignmentSchema = new Schema({
    id: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    reflectionPrompt: { type: String, required: true },
}, { _id: false });
const TruthReportSchema = new Schema({
    coreConflict: { type: String, required: true },
    truthSummary: { type: String, required: true },
    observedPatterns: { type: [String], default: [] },
    homework: { type: [HomeworkAssignmentSchema], default: [] },
    nextGoal: { type: String, required: true },
    honestyScore: { type: Number, required: true },
    clinicalFrame: { type: String, required: true },
}, { _id: false });
const SessionMetricsSchema = new Schema({
    interventionCount: { type: Number, default: 0 },
    overlapCount: { type: Number, default: 0 },
    localTranscriptCount: { type: Number, default: 0 },
    agentTranscriptCount: { type: Number, default: 0 },
    honestyScore: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
}, { _id: false });
const SessionSchema = new Schema({
    coupleId: { type: Schema.Types.ObjectId, required: true, ref: 'Couple', index: true },
    roomName: { type: String, required: true, unique: true, index: true },
    status: { type: String, required: true, default: 'pending' },
    selectedModel: { type: String, required: true },
    createdByUserId: { type: String, default: '' },
    liveKitDispatchId: { type: String },
    agentDispatchRequestedAt: { type: Date },
    openingContext: { type: String, default: '' },
    transcriptSegments: { type: [TranscriptSegmentSchema], default: [] },
    interventions: { type: [InterventionEventSchema], default: [] },
    report: { type: TruthReportSchema, default: null },
    metrics: { type: SessionMetricsSchema, default: () => ({}) },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
}, {
    timestamps: true,
});
export const SessionModel = model('Session', SessionSchema);
