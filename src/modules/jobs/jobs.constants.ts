export const MAINTENANCE_QUEUE = 'maintenance';

/**
 * Job names double as the scheduler ids. `upsertJobScheduler` is keyed on that
 * id, so re-registering on every boot is idempotent and exactly one worker in
 * the cluster claims each tick — which is the whole reason these are BullMQ
 * repeatable jobs and not `@Cron()`. See IMPLEMENTATION_PLAN §6.
 */
export const JOBS = {
  DAILY_CHALLENGE_GEN: 'daily-challenge-gen',
  LEADERBOARD_SNAPSHOT: 'leaderboard-snapshot',
  THEME_STATS_RECOMPUTE: 'theme-stats-recompute',
  PUSH_DAILY_NUDGE: 'push-daily-nudge',
  LEADERBOARD_REBUILD: 'leaderboard-rebuild',
  /**
   * Not scheduled — enqueued once per boot, so it is absent from
   * `JOB_SCHEDULES`. The catalogue changes when a deploy ships new files, which
   * is an event and not an hour of the day.
   */
  CATALOGUE_IMPORT: 'catalogue-import',
} as const;

/**
 * The advisory-lock key the import takes, so exactly one replica runs it.
 *
 * An arbitrary constant; it only has to be stable and not collide with another
 * advisory lock in this database, and it is the only one.
 */
export const CATALOGUE_IMPORT_LOCK = 8_419_207;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

/** Cron patterns are UTC — challenge identity is UTC everywhere. */
export const JOB_SCHEDULES: Array<{ name: JobName; pattern: string }> = [
  // Ahead of the 00:00 rollover, so tomorrow's set exists well before anyone
  // can ask for it.
  { name: JOBS.DAILY_CHALLENGE_GEN, pattern: '0 3 * * *' },
  // Just after rollover: freeze yesterday's ranks so today can show deltas.
  { name: JOBS.LEADERBOARD_SNAPSHOT, pattern: '5 0 * * *' },
  { name: JOBS.THEME_STATS_RECOMPUTE, pattern: '0 * * * *' },
  // Repairs a missed post-commit Redis mirror from authoritative Postgres.
  { name: JOBS.LEADERBOARD_REBUILD, pattern: '15 * * * *' },
  // Hourly, but only fires the timezone buckets currently at the target hour.
  { name: JOBS.PUSH_DAILY_NUDGE, pattern: '0 * * * *' },
];
