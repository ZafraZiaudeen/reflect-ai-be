import { Schema, model } from 'mongoose';
const ReflectionMemorySchema = new Schema({
    coupleId: { type: Schema.Types.ObjectId, required: true, ref: 'Couple', index: true },
    sessionId: { type: Schema.Types.ObjectId, required: true, ref: 'Session', index: true },
    memoryType: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    partnerRole: { type: String, required: true },
    partnerName: { type: String, required: true },
    assignmentTitle: { type: String, required: true },
    reflectionPrompt: { type: String, required: true },
    reflectionText: { type: String, required: true },
    sessionSummary: { type: String, default: '' },
    embedding: { type: [Number], default: [] },
    embeddingProvider: { type: String, default: 'local-hash' },
    embeddingFallback: { type: Boolean, default: false },
    sessionNumber: { type: Number, default: 1 },
}, {
    timestamps: true,
});
// Compound index for efficient chronological retrieval per couple
ReflectionMemorySchema.index({ coupleId: 1, createdAt: -1 });
// Compound index for upsert lookups
ReflectionMemorySchema.index({ coupleId: 1, sessionId: 1, memoryType: 1, userId: 1, assignmentTitle: 1 });
export const ReflectionMemoryModel = model('ReflectionMemory', ReflectionMemorySchema);
