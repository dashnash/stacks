/** The app's keys in its single table, and what each item holds. */
import type { Item } from '@stacks/api';
import type { FitReport } from '../game/fit';
import type { GameSummary, ShotRecord, TrainingRecord } from '../game/protocol';
import type { Tuning } from '../game/tuning';

/** Shots (and the configs they used) are kept 30 days. */
export const TELEMETRY_DAYS = 30;
export const LEADERBOARD_SIZE = 20;
/** Training runs (with their raw motion) are kept 90 days: long enough to refit them with a better fitter. */
export const TRAINING_DAYS = 90;

export const keys = {
  /** One per saved room: makes the save idempotent. */
  session: (roomId: string) => ({ PK: `SESSION#${roomId}`, SK: 'META' }),
  /** One per person: their best Rounds game. */
  leader: (userId: string) => ({ PK: 'LEADER', SK: userId }),
  /** A shooter's shots, newest last; GSI1 `SHOTS` lists everyone's (the owner's view). */
  shot: (userId: string, at: string, roomId: string, n: number) => ({
    PK: `SHOTS#${userId}`,
    SK: `${at}#${roomId}#${String(n).padStart(3, '0')}`,
    GSI1PK: 'SHOTS',
    GSI1SK: `${at}#${userId}#${roomId}#${String(n).padStart(3, '0')}`,
  }),
  config: (id: string) => ({ PK: `CONFIG#${id}`, SK: 'META' }),
  /** A person's own default tuning (what a new room starts with on their screen). */
  tuning: (userId: string) => ({ PK: `TUNING#${userId}`, SK: 'CURRENT' }),
  /** A person's training runs, newest last; GSI1 `TRAINING` lists everyone's (the owner's view). */
  training: (userId: string, at: string, roomId: string, n: number) => ({
    PK: `TRAINING#${userId}`,
    SK: `${at}#${roomId}#${n}`,
    GSI1PK: 'TRAINING',
    GSI1SK: `${at}#${userId}#${roomId}#${n}`,
  }),
};

export interface TuningItem extends Item {
  userId: string;
  tuning: Tuning;
  /** Where it came from: a calibration, a training run's fit, or set by hand from the tuning panel. */
  source: 'calibration' | 'training' | 'manual';
  at: string;
}

export interface TrainingItem extends Item, Omit<TrainingRecord, 'report'> {
  report: FitReport;
  roomId: string;
  at: string;
  expiresAt: number;
}

export interface SessionItem extends Item {
  roomId: string;
  userId: string;
  savedAt: string;
  games: GameSummary[];
  shots: number;
}

export interface LeaderItem extends Item {
  userId: string;
  name: string;
  score: number;
  accuracy: number;
  rounds: number;
  at: string;
  roomId: string;
}

export interface ShotItem extends Item, ShotRecord {
  roomId: string;
  /** Wall-clock time of the shot. */
  at: string;
  expiresAt: number;
}

export interface ConfigItem extends Item {
  id: string;
  tuning: Tuning;
  expiresAt: number;
}

/** First name only, for public lists. */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] || 'Someone';
