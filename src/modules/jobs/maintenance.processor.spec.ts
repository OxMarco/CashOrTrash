import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DataSource } from 'typeorm';

import { CatalogService } from '../catalog/catalog.service';
import { ItemCopyService } from '../catalog/copy/item-copy.service';
import { DailyService } from '../daily/daily.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { MatchesService } from '../matches/matches.service';
import { MediaGcService } from '../media/media-gc.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import { ITEM_COPY_LOCK, JOBS } from './jobs.constants';
import { MaintenanceProcessor } from './maintenance.processor';

const job = (name: string, attemptsMade = 1, attempts = 3): Job =>
  ({ id: '42', name, data: {}, attemptsMade, opts: { attempts } }) as Job;

describe('MaintenanceProcessor', () => {
  let itemCopy: { run: jest.Mock };
  let notifications: {
    sendDailyNudges: jest.Mock;
    checkPushReceipts: jest.Mock;
  };
  let runner: { connect: jest.Mock; query: jest.Mock; release: jest.Mock };
  let processor: MaintenanceProcessor;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    itemCopy = { run: jest.fn().mockResolvedValue({ written: 1 }) };
    notifications = {
      sendDailyNudges: jest.fn().mockResolvedValue(3),
      checkPushReceipts: jest
        .fn()
        .mockResolvedValue({ checked: 2, retired: 1 }),
    };
    runner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([{ locked: true }]),
      release: jest.fn().mockResolvedValue(undefined),
    };
    processor = new MaintenanceProcessor(
      {} as DailyService,
      {} as LeaderboardService,
      {} as CatalogService,
      itemCopy as unknown as ItemCopyService,
      notifications as unknown as NotificationsService,
      {} as UsersService,
      {} as MatchesService,
      {} as MediaGcService,
      { createQueryRunner: () => runner } as unknown as DataSource,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('routes the nudge and its receipt check', async () => {
    await expect(
      processor.process(job(JOBS.PUSH_DAILY_NUDGE)),
    ).resolves.toEqual({ sent: 3 });
    await expect(
      processor.process(job(JOBS.PUSH_RECEIPTS_CHECK)),
    ).resolves.toEqual({ checked: 2, retired: 1 });
  });

  describe('item copy', () => {
    it('runs under the advisory lock and releases it', async () => {
      await expect(processor.process(job(JOBS.ITEM_COPY))).resolves.toEqual({
        written: 1,
      });
      expect(runner.query).toHaveBeenLastCalledWith(
        'SELECT pg_advisory_unlock($1)',
        [ITEM_COPY_LOCK],
      );
      expect(runner.release).toHaveBeenCalled();
    });

    it('skips when another replica holds the lock', async () => {
      runner.query.mockResolvedValueOnce([{ locked: false }]);
      await expect(processor.process(job(JOBS.ITEM_COPY))).resolves.toEqual({
        skipped: 'lock-held',
      });
      expect(itemCopy.run).not.toHaveBeenCalled();
    });

    /**
     * An OpenAI outage is thrown out of the pass on purpose, so BullMQ retries
     * it. The lock must still be released, or every retry would find it held
     * and report success having done nothing.
     */
    it('lets a failed pass fail the job, and still unlocks', async () => {
      itemCopy.run.mockRejectedValue(new Error('OpenAI unavailable'));
      await expect(processor.process(job(JOBS.ITEM_COPY))).rejects.toThrow(
        'OpenAI unavailable',
      );
      expect(runner.query).toHaveBeenLastCalledWith(
        'SELECT pg_advisory_unlock($1)',
        [ITEM_COPY_LOCK],
      );
      expect(runner.release).toHaveBeenCalled();
    });
  });

  describe('worker events', () => {
    it('warns on a failure that will be retried', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

      processor.onFailed(job(JOBS.ITEM_COPY, 1, 3), new Error('timeout'));

      expect(warn).toHaveBeenCalledWith(
        'item-copy (42) failed on attempt 1/3 — will retry: timeout',
      );
      expect(error).not.toHaveBeenCalled();
    });

    it('errors on the failure that exhausts the retries', () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const cause = new Error('timeout');

      processor.onFailed(job(JOBS.ITEM_COPY, 3, 3), cause);

      expect(error).toHaveBeenCalledWith(
        { err: cause },
        'item-copy (42) failed on attempt 3/3 — giving up: timeout',
      );
    });

    it('logs a failure that arrived without a job', () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      processor.onFailed(undefined, new Error('lock lost'));
      expect(error).toHaveBeenCalledWith(
        'A job failed before it could be read: lock lost',
      );
    });

    it('logs stalls and worker errors', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

      processor.onStalled('42', 'active');
      processor.onError(new Error('ECONNRESET'));

      expect(warn).toHaveBeenCalledWith(
        'Job 42 stalled (was active) and will be re-run',
      );
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) as Error }),
        'Maintenance worker error: ECONNRESET',
      );
    });
  });
});
