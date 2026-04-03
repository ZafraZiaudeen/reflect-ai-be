import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * Stores individual reflections and session summaries with vector embeddings
 * for semantic search across the couple's entire history.
 *
 * ATLAS VECTOR SEARCH INDEX (create manually on Atlas if using $vectorSearch):
 *
 * {
 *   "name": "reflection_vector_index",
 *   "type": "vectorSearch",
 *   "definition": {
 *     "fields": [
 *       {
 *         "type": "vector",
 *         "numDimensions": 384,
 *         "path": "embedding",
 *         "similarity": "cosine"
 *       },
 *       {
 *         "type": "filter",
 *         "path": "coupleId"
 *       }
 *     ]
 *   }
 * }
 *
 * Without the Atlas index, the application falls back to in-memory cosine
 * similarity which works fine for the typical volume of reflections per couple.
 */

export interface ReflectionMemoryRecord {
  coupleId: Types.ObjectId;
  sessionId: Types.ObjectId;
  memoryType: 'reflection' | 'session_summary' | 'conversation_digest';
  userId: string;
  partnerRole: 'partner_a' | 'partner_b' | 'system';
  partnerName: string;
  assignmentTitle: string;
  reflectionPrompt: string;
  reflectionText: string;
  sessionSummary: string;
  embedding: number[];
  embeddingProvider: 'huggingface' | 'local-hash';
  embeddingFallback: boolean;
  sessionNumber: number;
  createdAt: Date;
  updatedAt: Date;
}

export type ReflectionMemoryDocument = HydratedDocument<ReflectionMemoryRecord>;

const ReflectionMemorySchema = new Schema<ReflectionMemoryRecord>(
  {
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
  },
  {
    timestamps: true,
  },
);

// Compound index for efficient chronological retrieval per couple
ReflectionMemorySchema.index({ coupleId: 1, createdAt: -1 });

// Compound index for upsert lookups
ReflectionMemorySchema.index({ coupleId: 1, sessionId: 1, memoryType: 1, userId: 1, assignmentTitle: 1 });

export const ReflectionMemoryModel: Model<ReflectionMemoryRecord> = model<ReflectionMemoryRecord>(
  'ReflectionMemory',
  ReflectionMemorySchema,
);
