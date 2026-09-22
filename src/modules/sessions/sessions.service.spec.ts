import { ConfigService } from '@nestjs/config';

import { CatalogService } from '../catalog/catalog.service';
import { Item } from '../catalog/entities/item.entity';
import { Currency } from '../currency/currency.constants';
import { CurrencyService } from '../currency/currency.service';
import { GameMode, SessionStatus } from './entities/game-session.entity';
import { SessionRound } from './entities/session-round.entity';
import { SessionsService } from './sessions.service';

/**
 * The results screen and the reveal before it describe the same bet, so they
 * have to quote it at the same rate. The reveal uses the rate stored on the
 * round; the summary used to re-quote at whatever the rate was when it was
 * asked, and the two drifted apart as soon as the rate moved.
 */
describe('SessionsService summary quoting', () => {
  // Today's rate is 2; the round was bet when it was 1.5.
  const LIVE_RATE = 2;
  const currency = {
    fromUsdCents: jest.fn(
      (cents: number, code: Currency, rate?: number): number =>
        code === 'USD' ? cents : Math.round(cents * (rate ?? LIVE_RATE)),
    ),
  } as unknown as CurrencyService;

  const item = { id: 11, title: 'Lamp', truePriceCents: 10_000 } as Item;
  const round = {
    sessionId: 's1',
    roundIndex: 0,
    itemId: 11,
    loCents: 8_000,
    hiCents: 12_000,
    hit: true,
    timedOut: false,
    elapsedMs: 4_000,
    basePoints: 100,
    multiplier: 1,
    points: 100,
    errorPct: 0,
    currency: 'EUR',
    exchangeRate: 1.5,
  } as unknown as SessionRound;

  const makeService = (): SessionsService => {
    const sessions = {
      findOne: jest.fn().mockResolvedValue({
        id: 's1',
        userId: 7,
        mode: GameMode.QUICK,
        status: SessionStatus.COMPLETE,
        itemIds: [11],
        totalScore: 100,
        matchId: null,
      }),
    };
    const rounds = { find: jest.fn().mockResolvedValue([round]) };
    const catalog = {
      findItemsInOrder: jest.fn().mockResolvedValue([item]),
      localise: jest.fn().mockResolvedValue({
        title: (i: Item) => i.title,
        conditionLine: () => '',
      }),
    } as unknown as CatalogService;
    const config = {
      getOrThrow: jest
        .fn()
        .mockReturnValue({ publicOrigin: 'https://example.test' }),
    } as unknown as ConfigService;

    const none = {} as never;
    return new SessionsService(
      sessions as never,
      rounds as never,
      none,
      catalog,
      none,
      none,
      none,
      currency,
      none,
      none,
      none,
      none,
      none,
      config,
    );
  };

  it('quotes a round in its own currency at the rate it was bet at', async () => {
    const summary = await makeService().getSummary('s1', 7, 'EUR');

    expect(summary.rounds[0]).toMatchObject({
      loCents: 12_000,
      hiCents: 18_000,
      truePriceCents: 15_000,
    });
  });

  it('uses the live rate for a currency the round was never quoted in', async () => {
    const summary = await makeService().getSummary('s1', 7, 'GBP');

    expect(summary.rounds[0]).toMatchObject({
      loCents: 16_000,
      hiCents: 24_000,
      truePriceCents: 20_000,
    });
  });
});
