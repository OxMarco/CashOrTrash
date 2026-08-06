import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { ImportConfig } from 'src/config/configuration';
import { CatalogModule } from '../catalog/catalog.module';
import { DailyModule } from '../daily/daily.module';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { JOB_SCHEDULES, JOBS, MAINTENANCE_QUEUE } from './jobs.constants';
import { MaintenanceProcessor } from './maintenance.processor';

@Module({
  imports: [
    BullModule.registerQueue({
      name: MAINTENANCE_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 200,
        removeOnFail: 500,
      },
    }),
    DailyModule,
    LeaderboardModule,
    CatalogModule,
    NotificationsModule,
  ],
  providers: [MaintenanceProcessor],
  exports: [BullModule],
})
export class JobsModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(JobsModule.name);

  constructor(
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  /**
   * Registered on every boot on purpose. `upsertJobScheduler` is keyed on the
   * scheduler id, so N replicas registering the same schedule converge on one
   * entry — and exactly one worker then claims each tick. `@Cron()` would fire
   * on every replica and generate tomorrow's challenge twice.
   */
  async onApplicationBootstrap(): Promise<void> {
    for (const { name, pattern } of JOB_SCHEDULES) {
      await this.queue.upsertJobScheduler(
        name,
        { pattern, tz: 'UTC' },
        { name, data: {} },
      );
    }

    this.logger.log(
      `Registered ${JOB_SCHEDULES.length} repeatable jobs, including ` +
        `${JOBS.LEADERBOARD_REBUILD} repair`,
    );

    await this.enqueueCatalogueImport();
  }

  /**
   * Queues the catalogue import rather than running it here.
   *
   * A deploy ships new files, so the import belongs to the boot — but not to
   * the boot *path*. `make deploy` smoke-tests `/health/ready`, and a cold
   * import that washes fifty photographs and calls a language model in between
   * would hold readiness open long enough to look like a failed deploy.
   *
   * The job carries no payload and its id is the job name, so the queue itself
   * collapses simultaneous boots into one entry. That is a convenience, not the
   * guarantee: a completed job eventually falls out of `removeOnComplete`, so
   * the processor takes an advisory lock as the actual guard.
   */
  private async enqueueCatalogueImport(): Promise<void> {
    if (!this.config.getOrThrow<ImportConfig>('import').onBoot) {
      this.logger.log('Catalogue import disabled (IMPORT_ON_BOOT=false)');
      return;
    }

    await this.queue.add(
      JOBS.CATALOGUE_IMPORT,
      {},
      { jobId: JOBS.CATALOGUE_IMPORT },
    );
    this.logger.log('Queued the catalogue import');
  }
}
