import { HealthCheckError } from '@nestjs/terminus';
import { Queue } from 'bullmq';

import { QueueHealthIndicator } from './queue.health';

const NOW = Date.parse('2026-09-22T12:00:00Z');
const HOUR = 60 * 60 * 1000;

const failedJob = (hoursAgo: number, name = 'daily-challenge-gen') => ({
  id: `${name}-${hoursAgo}`,
  name,
  finishedOn: NOW - hoursAgo * HOUR,
  timestamp: NOW - hoursAgo * HOUR - 1_000,
  failedReason: 'connection refused',
});

/**
 * The queue keeps up to 500 failed jobs as a debugging record. Readiness used
 * to count every one of them, so a single failure months ago held the probe —
 * and every deploy's smoke check — down for good.
 */
describe('QueueHealthIndicator', () => {
  let queue: { getJobCounts: jest.Mock; getFailed: jest.Mock };
  let indicator: QueueHealthIndicator;

  beforeEach(() => {
    queue = {
      getJobCounts: jest
        .fn()
        .mockResolvedValue({ waiting: 0, active: 0, failed: 3, delayed: 0 }),
      getFailed: jest.fn().mockResolvedValue([]),
    };
    indicator = new QueueHealthIndicator(queue as unknown as Queue);
  });

  it('is healthy with no failures at all', async () => {
    queue.getJobCounts.mockResolvedValue({ failed: 0 });
    await expect(indicator.isHealthy('queue', NOW)).resolves.toMatchObject({
      queue: { status: 'up' },
    });
  });

  it('ignores failures retained from more than a day ago', async () => {
    queue.getFailed.mockResolvedValue([failedJob(25), failedJob(24 * 30)]);
    await expect(indicator.isHealthy('queue', NOW)).resolves.toMatchObject({
      queue: { status: 'up' },
    });
  });

  it('fails on a job that failed within the last day, and says which', async () => {
    queue.getFailed.mockResolvedValue([
      failedJob(2, 'item-copy'),
      failedJob(30),
    ]);

    const failure = await indicator
      .isHealthy('queue', NOW)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HealthCheckError);
    const { causes } = failure as HealthCheckError;
    expect(causes).toEqual({
      queue: {
        status: 'down',
        message: expect.stringContaining(
          '1 maintenance job(s) failed in the last 24h, most recently item-copy',
        ) as string,
      },
    });
  });

  it('reads a bounded page of failures, newest first', async () => {
    await indicator.isHealthy('queue', NOW);
    expect(queue.getFailed).toHaveBeenCalledWith(0, 49);
  });

  it('reports Redis being unreachable as down rather than throwing raw', async () => {
    queue.getFailed.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(indicator.isHealthy('queue', NOW)).rejects.toBeInstanceOf(
      HealthCheckError,
    );
  });
});
