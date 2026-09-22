import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DataSource } from 'typeorm';

import { addDays, todayUtc } from 'src/common/utils/date.util';
import { CatalogService } from '../catalog/catalog.service';
import { ItemCopyService } from '../catalog/copy/item-copy.service';
import { DailyService } from '../daily/daily.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { MatchesService } from '../matches/matches.service';
import { MediaGcService } from '../media/media-gc.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import { ITEM_COPY_LOCK, JOBS, MAINTENANCE_QUEUE } from './jobs.constants';

@Processor(MAINTENANCE_QUEUE)
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(
    private readonly daily: DailyService,
    private readonly leaderboard: LeaderboardService,
    private readonly catalog: CatalogService,
    private readonly itemCopy: ItemCopyService,
    private readonly notifications: NotificationsService,
    private readonly users: UsersService,
    private readonly matches: MatchesService,
    private readonly mediaGc: MediaGcService,
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    this.logger.log(`Running ${job.name} (${job.id})`);

    switch (job.name) {
      case JOBS.DAILY_CHALLENGE_GEN:
        return { generated: await this.daily.ensureUpcoming() };

      case JOBS.LEADERBOARD_SNAPSHOT:
        return this.snapshot();

      case JOBS.THEME_STATS_RECOMPUTE:
        return { themes: await this.catalog.recomputeThemeStats() };

      case JOBS.PUSH_DAILY_NUDGE:
        return { sent: await this.notifications.sendDailyNudges() };

      case JOBS.PUSH_RECEIPTS_CHECK:
        return this.notifications.checkPushReceipts();

      case JOBS.LEADERBOARD_REBUILD:
        return this.rebuild(job.data as { date?: string });

      case JOBS.REGISTRATION_IP_PRUNE:
        return { cleared: await this.users.pruneRegistrationIps() };

      case JOBS.MATCH_INVITE_EXPIRE:
        return { expired: await this.matches.expireStaleInvites() };

      case JOBS.MEDIA_ORPHAN_SWEEP:
        return { deleted: await this.mediaGc.sweep() };

      case JOBS.ITEM_COPY:
        return this.writeItemCopy();

      default:
        this.logger.warn(`Unknown job: ${job.name}`);
        return null;
    }
  }

  /**
   * A job threw. Logged on every attempt, not only the last, because the
   * attempts are where the story is: a job that fails twice and passes on the
   * third is a flaky dependency worth knowing about, and without this the only
   * trace of it would be the backoff delay. `attemptsMade` already counts this
   * one when the event fires.
   *
   * The final failure is the one readiness reacts to — see `QueueHealthIndicator`
   * — so it is logged at error and says so.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    if (!job) {
      // BullMQ passes no job when the failure was in fetching one — a lock
      // lost before the job could be read, for instance.
      this.logger.error(
        `A job failed before it could be read: ${error.message}`,
      );
      return;
    }
    const attempts = job.opts.attempts ?? 1;
    const final = job.attemptsMade >= attempts;
    const line =
      `${job.name} (${job.id}) failed on attempt ${job.attemptsMade}/${attempts}` +
      `${final ? ' — giving up' : ' — will retry'}: ${error.message}`;
    if (final) this.logger.error({ err: error }, line);
    else this.logger.warn(line);
  }

  /**
   * The worker holding a job stopped renewing its lock — a process killed
   * mid-job, or an event loop blocked past the lock duration. BullMQ moves the
   * job back to waiting (or fails it after `maxStalledCount`), so nothing is
   * lost, but a job that stalls is one that may run twice.
   */
  @OnWorkerEvent('stalled')
  onStalled(jobId: string, previous: string): void {
    this.logger.warn(
      `Job ${jobId} stalled (was ${previous}) and will be re-run`,
    );
  }

  /**
   * The worker itself erred — almost always its Redis connection. Without a
   * listener this surfaces nowhere: the worker retries on its own, and the only
   * symptom would be jobs that quietly stop running.
   */
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      { err: error },
      `Maintenance worker error: ${error.message}`,
    );
  }

  /**
   * Writes the prose the portal's uploads are still owed.
   *
   * Behind an advisory lock rather than trusting the queue alone. BullMQ hands
   * one job to one worker, but the portal enqueues on every upload and a job
   * that has already completed and been trimmed can be enqueued again — two
   * replicas running the pass together would send the same items to the model
   * twice and pay for both.
   *
   * `pg_try_advisory_lock` rather than the blocking form: a second replica
   * should decide there is nothing to do and get on with serving, not hold a
   * connection waiting to redo work that is already being done.
   */
  private async writeItemCopy(): Promise<unknown> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();

    try {
      const [{ locked }] = (await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [ITEM_COPY_LOCK],
      )) as [{ locked: boolean }];

      if (!locked) {
        this.logger.log('Another replica is writing item copy — skipping');
        return { skipped: 'lock-held' };
      }

      try {
        return await this.itemCopy.run();
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1)', [ITEM_COPY_LOCK]);
      }
    } finally {
      await runner.release();
    }
  }

  /**
   * Snapshots yesterday as well as today: the job runs just after midnight
   * UTC, and yesterday's board is the one whose final ranks matter.
   */
  private async snapshot(): Promise<Record<string, number>> {
    const today = todayUtc();
    const yesterday = addDays(today, -1);

    const [yesterdayRows, todayRows] = await Promise.all([
      this.leaderboard.snapshotRanks(yesterday),
      this.leaderboard.snapshotRanks(today),
    ]);

    // Roll the serving keys so the new day starts from the source of truth.
    await this.leaderboard.rebuild('today');
    await this.leaderboard.rebuild('week');

    return { [yesterday]: yesterdayRows, [today]: todayRows };
  }

  private async rebuild(data: {
    date?: string;
  }): Promise<Record<string, number>> {
    const now = data.date ? new Date(`${data.date}T12:00:00.000Z`) : new Date();
    return {
      daily: await this.leaderboard.rebuild('today', now),
      weekly: await this.leaderboard.rebuild('week', now),
    };
  }
}
