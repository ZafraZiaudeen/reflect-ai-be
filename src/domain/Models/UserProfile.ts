import { Schema, model, type HydratedDocument, type Model } from 'mongoose';

export interface UserProfileRecord {
  clerkUserId: string;
  email?: string;
  displayName: string;
  avatarUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type UserProfileDocument = HydratedDocument<UserProfileRecord>;

const UserProfileSchema = new Schema<UserProfileRecord>(
  {
    clerkUserId: { type: String, required: true, unique: true, index: true },
    email: { type: String },
    displayName: { type: String, required: true },
    avatarUrl: { type: String },
  },
  {
    timestamps: true,
  },
);

export const UserProfileModel: Model<UserProfileRecord> = model<UserProfileRecord>(
  'UserProfile',
  UserProfileSchema,
);
