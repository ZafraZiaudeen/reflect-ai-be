import mongoose from 'mongoose';
import { env, ensureEnvValue } from '../Config/env.js';

let connectionPromise: Promise<typeof mongoose> | null = null;

export const connectDatabase = async (): Promise<typeof mongoose> => {
  if (!connectionPromise) {
    connectionPromise = mongoose.connect(ensureEnvValue(env.MONGODB_URL, 'MONGODB_URL'));
  }

  return connectionPromise;
};
