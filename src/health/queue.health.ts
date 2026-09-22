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

/**
 * How far back a failure still counts.
 *
 * The queue keeps its last 500 failed jobs (`removeOnFail` in JobsModule) as a
 * record to debug from, not as an alarm. Counting all of them meant one failed
 * job held readiness down until 500 more had failed after it — in practice
 * forever — so an alert that fired once could never clear, and `make deploy`'s
 * smoke check failed on every release after it. A day is long enough for the
 * alert to be seen and short enough that it clears on its own once whatever
 * broke has stopped breaking. `make queue-clean-failed` clears it sooner.
 */
const FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many of the newest failures are read to count the window.
 *
 * Bounded so a probe polled every few seconds never pages through the whole
 * retained set. `getFailed` returns newest first, so this many is enough to
 * know the window holds at least this many — and anything over the threshold
 * is the same verdict.
 */
const FAILED_SCAN = 50;

@Injectable()
export class QueueHealthIndicator extends HealthIndicator {
  constructor(@InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue) {
    super();
  }

  async isHealthy(
    key: string,
    now: number = Date.now(),
  ): Promise<HealthIndicatorResult> {
    try {
      const [counts, failures] = await withTimeout(
        Promise.all([
          this.queue.getJobCounts('waiting', 'active', 'failed', 'delayed'),
          this.queue.getFailed(0, FAILED_SCAN - 1),
        ]),
        2_000,
        'Queue health check',
      );

      const since = now - FAILED_WINDOW_MS;
      const recent = failures.filter(
        (job) => (job.finishedOn ?? job.timestamp) >= since,
      );

      if (recent.length >= FAILED_THRESHOLD) {
        const newest = recent[0];
        throw new Error(
          `${recent.length} maintenance job(s) failed in the last 24h, ` +
            `most recently ${newest.name} (${newest.id}): ${newest.failedReason ?? 'no reason recorded'}`,
        );
      }

      return this.getStatus(key, true, { ...counts, failedLast24h: 0 });
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
