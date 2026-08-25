import { isoWeekKey, todayUtc } from 'src/common/utils/date.util';

export type LeaderboardScope = 'today' | 'week' | 'friends';

/**
 * Redis is a cache here, never the source of truth — every key below can be
 * reconstructed from `daily_score` by the `leaderboard-rebuild` job.
 */
export const dailyKey = (date: string = todayUtc()): string =>
  `lb:daily:${date}`;

export const weekKey = (date: Date = new Date()): string =>
  `lb:week:${isoWeekKey(date)}`;

/** Ephemeral: built per request from Friendship, then dropped. */
export const friendsKey = (userId: number): string => `lb:friends:${userId}`;

/** Exists even when the corresponding sorted set has zero members. */
export const boardReadyKey = (boardKey: string): string =>
  `leaderboard-ready:${boardKey}`;

/** Short lease that collapses concurrent cache-miss rebuilds. */
export const boardRebuildLockKey = (boardKey: string): string =>
  `leaderboard-rebuild-lock:${boardKey}`;

/** Daily keys outlive the day so "yesterday" stays queryable during rollover. */
export const DAILY_TTL_SECONDS = 60 * 60 * 24 * 3;
export const WEEK_TTL_SECONDS = 60 * 60 * 24 * 14;
export const FRIENDS_TTL_SECONDS = 30;
