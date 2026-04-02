import { Schema, model } from 'mongoose';
const UserProfileSchema = new Schema({
    clerkUserId: { type: String, required: true, unique: true, index: true },
    email: { type: String },
    displayName: { type: String, required: true },
    avatarUrl: { type: String },
}, {
    timestamps: true,
});
export const UserProfileModel = model('UserProfile', UserProfileSchema);
