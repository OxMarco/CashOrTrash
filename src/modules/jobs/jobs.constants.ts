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
  /**
   * Follows the nudge up: asks Expo for the receipts of what it sent and
   * retires the devices that no longer exist. A send's ticket only says the
   * message was accepted — an uninstalled app is usually only reported here.
   */
  PUSH_RECEIPTS_CHECK: 'push-receipts-check',
  LEADERBOARD_REBUILD: 'leaderboard-rebuild',
  /**
   * Ages out `user.registrationIp`, the only retained network identifier. It
   * exists so an abuse investigation can ask "how many accounts came
   * from this address"; that question is only ever asked about recent
   * registrations, so keeping the answer for the life of the account is
   * collecting something for no purpose.
   */
  REGISTRATION_IP_PRUNE: 'registration-ip-prune',
  /**
   * Flips invites nobody answered to `expired`. Hygiene rather than
   * enforcement: `inviteHasExpired` already refuses a stale code the moment
   * the deadline passes, so this exists to keep the stored status honest and
   * the pending set the size of the genuinely open invites.
   */
  MATCH_INVITE_EXPIRE: 'match-invite-expire',
  /** Deletes old content-addressed photos no catalogue row references. */
  MEDIA_ORPHAN_SWEEP: 'media-orphan-sweep',
  /**
   * Not scheduled — enqueued by the admin portal when an item is uploaded, so
   * it is absent from `JOB_SCHEDULES`. New catalogue content is an event and
   * not an hour of the day.
   */
  ITEM_COPY: 'item-copy',
} as const;

/**
 * The advisory-lock key the copy pass takes, so exactly one replica runs it.
 *
 * An arbitrary constant; it only has to be stable and not collide with another
 * advisory lock in this database, and it is the only one. It matters more here
 * than it did for the import: two replicas running the pass together would both
 * bill OpenAI for the same items.
 */
export const ITEM_COPY_LOCK = 8_419_207;

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
  // Half an hour behind the nudge, past the fifteen minutes Expo asks callers
  // to wait before receipts are ready.
  { name: JOBS.PUSH_RECEIPTS_CHECK, pattern: '30 * * * *' },
  // Daily, in the quiet hour before the challenge generator.
  { name: JOBS.REGISTRATION_IP_PRUNE, pattern: '30 2 * * *' },
  // Alongside it, in the same quiet hour.
  { name: JOBS.MATCH_INVITE_EXPIRE, pattern: '45 2 * * *' },
  { name: JOBS.MEDIA_ORPHAN_SWEEP, pattern: '15 2 * * *' },
];
