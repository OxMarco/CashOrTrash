import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DataSource } from 'typeorm';

import { addDays, todayUtc } from 'src/common/utils/date.util';
import { CatalogService } from '../catalog/catalog.service';
import { CatalogImportService } from '../catalog/import/catalog-import.service';
import { DailyService } from '../daily/daily.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CATALOGUE_IMPORT_LOCK,
  JOBS,
  MAINTENANCE_QUEUE,
} from './jobs.constants';

@Processor(MAINTENANCE_QUEUE)
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(
    private readonly daily: DailyService,
    private readonly leaderboard: LeaderboardService,
    private readonly catalog: CatalogService,
    private readonly catalogImport: CatalogImportService,
    private readonly notifications: NotificationsService,
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

      case JOBS.LEADERBOARD_REBUILD:
        return this.rebuild(job.data as { date?: string });

      case JOBS.CATALOGUE_IMPORT:
        return this.importCatalogue();

      default:
        this.logger.warn(`Unknown job: ${job.name}`);
        return null;
    }
  }

  /**
   * Reconciles the catalogue to the `items/` tree the image shipped with.
   *
   * Behind an advisory lock rather than trusting the queue alone. BullMQ hands
   * one job to one worker, but every replica enqueues on boot and a job that
   * has already completed and been trimmed can be enqueued again — two replicas
   * washing the same photographs at once is precisely the concurrent decode the
   * memory ceiling is set to avoid.
   *
   * `pg_try_advisory_lock` rather than the blocking form: a second replica
   * should decide there is nothing to do and get on with serving, not hold a
   * connection waiting to redo work that is already being done.
   */
  private async importCatalogue(): Promise<unknown> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();

    try {
      const [{ locked }] = (await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [CATALOGUE_IMPORT_LOCK],
      )) as [{ locked: boolean }];

      if (!locked) {
        this.logger.log(
          'Another replica is importing the catalogue — skipping',
        );
        return { skipped: 'lock-held' };
      }

      try {
        return await this.catalogImport.run();
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1)', [
          CATALOGUE_IMPORT_LOCK,
        ]);
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
