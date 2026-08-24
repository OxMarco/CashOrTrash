import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';

import { CatalogService } from '../catalog/catalog.service';
import { DailyService } from './daily.service';
import { DailyChallenge } from './entities/daily-challenge.entity';

describe('DailyService', () => {
  const app = {
    roundsPerSession: 5,
    dailySeedSecret: 'a-daily-seed-secret-of-at-least-32-chars',
    dailyPregenerateDays: 7,
  };

  let drawItemIds: jest.Mock;
  let challenges: jest.Mocked<Pick<Repository<DailyChallenge>, 'findOne'>>;
  let service: DailyService;

  const build = () => {
    drawItemIds = jest.fn().mockResolvedValue([1, 2, 3, 4, 5]);
    challenges = { findOne: jest.fn() };

    const repo = {
      ...challenges,
      findOneOrFail: jest
        .fn()
        .mockImplementation(({ where }: { where: { challengeDate: string } }) =>
          Promise.resolve({
            challengeDate: where.challengeDate,
            itemIds: [1, 2, 3, 4, 5],
            seed: 'x',
          }),
        ),
      createQueryBuilder: () => ({
        insert: () => ({
          into: () => ({
            values: () => ({ orIgnore: () => ({ execute: jest.fn() }) }),
          }),
        }),
      }),
    } as unknown as Repository<DailyChallenge>;

    const catalog = {
      drawItemIds,
      itemCountsByTheme: jest.fn().mockResolvedValue(new Map([[1, 500]])),
    } as unknown as CatalogService;

    return new DailyService(repo, catalog, {
      getOrThrow: () => app,
    } as unknown as ConfigService);
  };

  beforeEach(() => {
    service = build();
  });

  /**
   * Every generated day is subtracted from the pool the next one draws from.
   *
   * Without this the days were independent shuffles of one catalogue, so two of
   * them collided readily — and a player who sat Tuesday's challenge was handed
   * a price they would be tested on again on Friday. That is the exact leak the
   * reserve exists to close, and the daily generator was the one caller not
   * subject to it.
   */
  it('holds back items another challenge has already claimed', async () => {
    await service.generate('2026-08-12');

    expect(drawItemIds).toHaveBeenCalledWith(null, 5, expect.any(String), {
      reserveDaily: true,
    });
  });

  /**
   * `excludeSeenBy` is the exclusion that would break the daily, and the
   * distinction is the whole reason `reserveDaily` is safe here: one is a fact
   * about the calendar, identical for everyone; the other is a fact about the
   * caller, and would make "the same five items for everyone" false.
   */
  it('never filters the daily pool by who is asking', async () => {
    await service.generate('2026-08-12');

    const [, , , options] = drawItemIds.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(options).not.toHaveProperty('excludeSeenBy');
  });

  /** The seed is a keyed digest, not the date — see `seedForDate`. */
  it('seeds each date differently and reveals none of them', async () => {
    const twelfth = await service.generate('2026-08-12');
    const [, , seedTwelfth] = drawItemIds.mock.calls[0] as string[];

    service = build();
    await service.generate('2026-08-13');
    const [, , seedThirteenth] = drawItemIds.mock.calls[0] as string[];

    expect(seedTwelfth).toMatch(/^[0-9a-f]{64}$/);
    expect(seedTwelfth).not.toBe(seedThirteenth);
    expect(seedTwelfth).not.toContain('2026-08-12');
    expect(twelfth.challengeDate).toBe('2026-08-12');
  });

  it('generates today plus the configured lookahead, skipping days already made', async () => {
    const now = new Date('2026-08-10T04:00:00.000Z');
    // The 11th already exists; every other day in the window does not.
    challenges.findOne.mockImplementation(
      ({ where }: { where: { challengeDate: string } }) =>
        Promise.resolve(
          where.challengeDate === '2026-08-11'
            ? ({ challengeDate: '2026-08-11' } as DailyChallenge)
            : null,
        ),
    );

    const generated = await service.ensureUpcoming(now);

    expect(generated).toEqual([
      '2026-08-10',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      '2026-08-16',
      '2026-08-17',
    ]);
  });
});
