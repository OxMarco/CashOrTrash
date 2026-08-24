import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';

import { GameSession } from '../sessions/entities/game-session.entity';
import { SessionRound } from '../sessions/entities/session-round.entity';
import { ItemCopy } from '../catalog/entities/item-copy.entity';
import { CurrencyService } from '../currency/currency.service';

import { User } from './entities/user.entity';
import { UsernameService } from './username.service';
import { UsersService } from './users.service';

describe('UsersService leaderboard eligibility', () => {
  const users = { findOne: jest.fn() } as unknown as Repository<User>;
  const usernames = {} as UsernameService;
  const dataSource = {} as DataSource;

  beforeEach(() => jest.clearAllMocks());

  it('keeps new anonymous accounts off the board during probation', async () => {
    const service = makeService(24);
    (users.findOne as jest.Mock).mockResolvedValue({
      id: 7,
      createdAt: new Date('2026-08-06T00:00:00Z'),
    });

    await expect(
      service.isLeaderboardEligible(7, new Date('2026-08-06T23:59:59Z')),
    ).resolves.toBe(false);
    await expect(
      service.isLeaderboardEligible(7, new Date('2026-08-07T00:00:00Z')),
    ).resolves.toBe(true);
  });

  it('allows immediate ranking when probation is disabled', async () => {
    await expect(makeService(0).isLeaderboardEligible(7)).resolves.toBe(true);
    expect(users.findOne).not.toHaveBeenCalled();
  });

  it('does not rank a missing account', async () => {
    (users.findOne as jest.Mock).mockResolvedValue(null);
    await expect(makeService(24).isLeaderboardEligible(404)).resolves.toBe(
      false,
    );
  });

  function makeService(
    hours: number,
    session: unknown = null,
    retentionDays = 30,
  ): UsersService {
    const config = {
      getOrThrow: jest.fn().mockReturnValue({
        leaderboardMinAccountAgeHours: hours,
        roundsPerSession: 5,
        registrationIpRetentionDays: retentionDays,
      }),
    } as unknown as ConfigService;
    const sessions = {
      findOne: jest.fn().mockResolvedValue(session),
    } as unknown as Repository<GameSession>;
    const rounds = {
      find: jest.fn().mockResolvedValue([]),
    } as unknown as Repository<SessionRound>;
    const copies = {
      findOne: jest.fn().mockResolvedValue(null),
    } as unknown as Repository<ItemCopy>;
    const currency = {
      fromUsdCents: (cents: number) => cents,
    } as unknown as CurrencyService;
    return new UsersService(
      users,
      sessions,
      rounds,
      copies,
      currency,
      usernames,
      dataSource,
      config,
    );
  }

  describe('progress through today’s challenge', () => {
    // Answered before the challenge is started, so Home can render "Play" from
    // the same response it renders "Continue · round 3" from.
    it('reports a challenge nobody has started as untouched', async () => {
      await expect(
        makeService(24).dailyProgress(1, '2026-08-08'),
      ).resolves.toEqual({
        challengeDate: '2026-08-08',
        roundsPlayed: 0,
        roundCount: 5,
        complete: false,
      });
    });

    it('counts the rounds already behind the one being played', async () => {
      const service = makeService(24, {
        itemIds: [1, 2, 3, 4, 5],
        currentIndex: 3,
      });

      await expect(
        service.dailyProgress(1, '2026-08-08'),
      ).resolves.toMatchObject({ roundsPlayed: 3, complete: false });
    });

    // A finished session stops at `roundCount`, and the card has to read that as
    // done rather than as a sixth round waiting to be played.
    it('reads a finished challenge as complete', async () => {
      const service = makeService(24, {
        itemIds: [1, 2, 3, 4, 5],
        currentIndex: 5,
      });

      await expect(
        service.dailyProgress(1, '2026-08-08'),
      ).resolves.toMatchObject({ roundsPlayed: 5, complete: true });
    });
  });

  /**
   * `registrationIp` is the only retained network identifier, kept to
   * answer one question — "did these accounts all come from one address?" —
   * that is only ever asked about recent registrations. Past the window it is
   * being retained for no purpose, which is the part that makes it a liability
   * rather than a control.
   */
  describe('ageing out registration addresses', () => {
    const execute = jest.fn().mockResolvedValue({ affected: 3 });
    const where = jest.fn();
    const andWhere = jest.fn();

    const set = jest.fn();
    // A chainable stand-in for the query builder: every step returns itself,
    // and the spies record what the sweep asked for.
    const builder: Record<string, unknown> = { execute };
    builder.update = () => builder;
    builder.set = (...args: unknown[]) => {
      set(...args);
      return builder;
    };
    builder.where = (...args: unknown[]) => {
      where(...args);
      return builder;
    };
    builder.andWhere = (...args: unknown[]) => {
      andWhere(...args);
      return builder;
    };

    beforeEach(() => {
      jest.clearAllMocks();
      (users as unknown as { createQueryBuilder: unknown }).createQueryBuilder =
        () => builder;
    });

    it('clears the address on accounts past the window, and nothing else', async () => {
      const now = new Date('2026-08-10T00:00:00Z');

      await expect(
        makeService(24, null, 30).pruneRegistrationIps(now),
      ).resolves.toBe(3);

      expect(set).toHaveBeenCalledWith({ registrationIp: null });
      // Bounded by the partial index, so the sweep never reads the whole table.
      expect(where).toHaveBeenCalledWith('"registrationIp" IS NOT NULL');
      expect(andWhere).toHaveBeenCalledWith('"createdAt" < :cutoff', {
        cutoff: new Date('2026-07-11T00:00:00Z'),
      });
    });

    /** Keeping addresses for the life of the account has to be a choice. */
    it('does not run at all when retention is switched off', async () => {
      await expect(
        makeService(24, null, 0).pruneRegistrationIps(),
      ).resolves.toBe(0);
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
