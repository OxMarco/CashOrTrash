import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import {
  HealthCheckError,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { Queue } from 'bullmq';

import { withTimeout } from 'src/common/utils/with-timeout';
import { MAINTENANCE_QUEUE } from 'src/modules/jobs/jobs.constants';

/** A scheduled maintenance job exhausting its retries needs operator attention. */
const FAILED_THRESHOLD = 1;

@Injectable()
export class QueueHealthIndicator extends HealthIndicator {
  constructor(@InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const counts = await withTimeout(
        this.queue.getJobCounts('waiting', 'active', 'failed', 'delayed'),
        2_000,
        'Queue health check',
      );

      const healthy = (counts.failed ?? 0) < FAILED_THRESHOLD;
      if (!healthy) {
        throw new Error(`${counts.failed} failed maintenance jobs`);
      }

      return this.getStatus(key, true, counts);
    } catch (error) {
      throw new HealthCheckError(
        'Queue is unhealthy',
        this.getStatus(key, false, {
          message: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }
  }
}
