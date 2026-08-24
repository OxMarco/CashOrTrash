import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';

import { CatalogModule } from '../catalog/catalog.module';
import { DailyModule } from '../daily/daily.module';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { MatchesModule } from '../matches/matches.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
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
    UsersModule,
    MatchesModule,
  ],
  providers: [MaintenanceProcessor],
  exports: [BullModule],
})
export class JobsModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(JobsModule.name);

  constructor(@InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue) {}

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

    await this.enqueueItemCopy();
  }

  /**
   * Sweeps up copy the portal is still owed, once per boot.
   *
   * The portal enqueues this itself on every upload, so in steady state the
   * boot run finds nothing. It exists for the case the portal cannot cover: a
   * process that died mid-pass, or an OpenAI outage that ran through the job's
   * retries. Those items sit flagged in the database and would otherwise wait
   * for the next upload to carry them along.
   *
   * Queued rather than run here. `make deploy` smoke-tests `/health/ready`, and
   * a backlog that calls a language model for two dozen items would hold
   * readiness open long enough to look like a failed deploy.
   *
   * Every boot gets a fresh job. Reusing a fixed id looks attractive, but
   * BullMQ also de-duplicates against retained *completed* jobs, so a backlog
   * could then be skipped until 200 unrelated jobs had run. The processor's
   * advisory lock is the actual cross-replica guard.
   */
  private async enqueueItemCopy(): Promise<void> {
    await this.queue.add(JOBS.ITEM_COPY, {});
    this.logger.log('Queued a catch-up pass for outstanding item copy');
  }
}
