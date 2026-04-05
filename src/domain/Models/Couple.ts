import { Schema, model, type HydratedDocument, type Model } from 'mongoose';
import type { HomeworkGate, WorkspaceInvitation } from '../Types/mirror.js';

const HomeworkReflectionSchema = new Schema(
  {
    userId: { type: String, required: true },
    completed: { type: Boolean, required: true },
    reflection: { type: String, required: true },
    submittedAt: { type: Date, required: true },
  },
  { _id: false },
);

const HomeworkAssignmentSchema = new Schema(
  {
    id: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    reflectionPrompt: { type: String, required: true },
    targetPartnerRole: { type: String },
    submission: { type: HomeworkReflectionSchema, default: null },
    reflections: { type: [HomeworkReflectionSchema], default: undefined },
  },
  { _id: false },
);

const HomeworkGateSchema = new Schema<HomeworkGate>(
  {
    sourceSessionId: { type: String, required: true },
    createdAt: { type: Date, required: true },
    requiredReflections: { type: Number, required: true, default: 2 },
    unlockedAt: { type: Date, default: null },
    assignments: { type: [HomeworkAssignmentSchema], default: [] },
  },
  { _id: false },
);

const WorkspaceInvitationSchema = new Schema<WorkspaceInvitation>(
  {
    email: { type: String, required: true },
    recipientName: { type: String },
    invitedByUserId: { type: String, required: true },
    invitedByName: { type: String, required: true },
    sentAt: { type: Date, required: true },
  },
  { _id: false },
);

export interface CoupleRecord {
  inviteCode: string;
  partnerAUserId: string;
  partnerAName: string;
  partnerAEmail?: string;
  partnerAAvatarUrl?: string;
  partnerBUserId?: string;
  partnerBName?: string;
  partnerBEmail?: string;
  partnerBAvatarUrl?: string;
  preferredModel: string;
  memorySummary: string;
  activeHomeworkGate?: HomeworkGate | null;
  pendingInvitation?: WorkspaceInvitation | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CoupleDocument = HydratedDocument<CoupleRecord>;

const CoupleSchema = new Schema<CoupleRecord>(
  {
    inviteCode: { type: String, required: true, unique: true, index: true },
    partnerAUserId: { type: String, required: true, index: true },
    partnerAName: { type: String, required: true },
    partnerAEmail: { type: String },
    partnerAAvatarUrl: { type: String },
    partnerBUserId: { type: String, index: true },
    partnerBName: { type: String },
    partnerBEmail: { type: String },
    partnerBAvatarUrl: { type: String },
    preferredModel: { type: String, required: true },
    memorySummary: { type: String, default: '' },
    activeHomeworkGate: { type: HomeworkGateSchema, default: null },
    pendingInvitation: { type: WorkspaceInvitationSchema, default: null },
  },
  {
    timestamps: true,
  },
);

export const CoupleModel: Model<CoupleRecord> = model<CoupleRecord>('Couple', CoupleSchema);
