import { ConfigService } from '@nestjs/config';
import { Cache } from 'cache-manager';
import { DataSource, Repository } from 'typeorm';

import { GameSession } from '../sessions/entities/game-session.entity';
import { SessionRound } from '../sessions/entities/session-round.entity';
import { ItemCopy } from '../catalog/entities/item-copy.entity';
import { CurrencyService } from '../currency/currency.service';

import { hashDeviceId } from './device-id';
import { User } from './entities/user.entity';
import { UsernameService } from './username.service';
import { UsersService } from './users.service';

describe('UsersService leaderboard eligibility', () => {
  const users = { findOne: jest.fn() } as unknown as Repository<User>;
  const usernames = {} as UsernameService;
  const dataSource = {} as DataSource;
  const cache = {
    get: jest.fn().mockResolvedValue(undefined),
    mget: jest.fn().mockResolvedValue([undefined, undefined]),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  } as unknown as Cache;

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
    source: DataSource = dataSource,
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
      source,
      cache,
      config,
    );
  }

  /**
   * The device id is the account's credential, so the table holds only its
   * digest — and the lookups have to ask for the digest, or every returning
   * player would register as a stranger.
   */
  describe('device ids', () => {
    it('looks a returning device up by its digest, never the id itself', async () => {
      (users.findOne as jest.Mock).mockResolvedValue(null);

      await makeService(0).findByDeviceId('device-abc-123');

      expect(users.findOne).toHaveBeenCalledWith({
        where: { deviceIdHash: hashDeviceId('device-abc-123') },
      });
    });

    it('registers a new device under its digest', async () => {
      const values = jest.fn();
      const builder: Record<string, unknown> = {
        execute: jest.fn().mockResolvedValue({ raw: [{ id: 9 }] }),
      };
      for (const step of ['insert', 'into', 'orIgnore', 'returning']) {
        builder[step] = () => builder;
      }
      builder.values = (row: unknown) => {
        values(row);
        return builder;
      };
      (users as unknown as { createQueryBuilder: unknown }).createQueryBuilder =
        () => builder;
      (users.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        makeService(0).findOrCreateByDeviceId('device-abc-123', null),
      ).resolves.toEqual({ user: { id: 9 }, created: true });

      const row = values.mock.calls[0][0] as Record<string, unknown>;
      expect(row.deviceIdHash).toBe(hashDeviceId('device-abc-123'));
      expect(JSON.stringify(row)).not.toContain('device-abc-123');
    });
  });

  /**
   * A deleted player's token must stop working, and the cache in front of the
   * existence check is the one thing that could keep it alive — a request that
   * read the row just before the deletion committed can write "exists" back
   * after the deletion cleared it.
   */
  describe('existence after deletion', () => {
    it('answers from the cached positive without asking the database', async () => {
      (cache.mget as jest.Mock).mockResolvedValue([undefined, true]);
      (users as unknown as { exist: jest.Mock }).exist = jest.fn();

      await expect(makeService(0).stillExists(5)).resolves.toBe(true);
      expect(
        (users as unknown as { exist: jest.Mock }).exist,
      ).not.toHaveBeenCalled();
    });

    it('lets the deletion tombstone overrule a positive written after it', async () => {
      (cache.mget as jest.Mock).mockResolvedValue([true, true]);
      (users as unknown as { exist: jest.Mock }).exist = jest.fn();

      await expect(makeService(0).stillExists(5)).resolves.toBe(false);
      expect(cache.mget).toHaveBeenCalledWith([
        'auth:user-deleted:5',
        'auth:user-exists:5',
      ]);
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('falls through to the database when the cache is down', async () => {
      (cache.mget as jest.Mock).mockRejectedValue(new Error('offline'));
      (users as unknown as { exist: jest.Mock }).exist = jest
        .fn()
        .mockResolvedValue(true);

      await expect(makeService(0).stillExists(5)).resolves.toBe(true);
    });

    it('writes a tombstone outliving the positive cache once the deletion commits', async () => {
      const query = jest
        .fn()
        .mockImplementation((sql: string) =>
          Promise.resolve(sql.includes('FROM "user"') ? [{ id: 5 }] : []),
        );
      const manager = { query, delete: jest.fn() };
      const transactional = {
        transaction: (run: (m: unknown) => Promise<void>) => run(manager),
      } as unknown as DataSource;

      await makeService(0, null, 30, transactional).deleteAccount(5);

      expect(cache.set).toHaveBeenCalledWith(
        'auth:user-deleted:5',
        true,
        expect.any(Number),
      );
      const ttl = (cache.set as jest.Mock).mock.calls[0][2] as number;
      expect(ttl).toBeGreaterThanOrEqual(30_000);
      expect(cache.del).toHaveBeenCalledWith('auth:user-exists:5');
    });

    /**
     * Deleting an account removes the opponent's side of every shared match,
     * but the opponent keeps the points those rounds paid them.
     */
    it('leaves the opponent’s totals untouched', async () => {
      const query = jest.fn().mockImplementation((sql: string) => {
        if (sql.startsWith('SELECT id FROM "user"')) {
          return Promise.resolve([{ id: 5 }]);
        }
        if (sql.includes('SELECT id FROM "match"')) {
          return Promise.resolve([{ id: 'm-1' }]);
        }
        return Promise.resolve([]);
      });
      const builder: Record<string, unknown> = {
        execute: () => Promise.resolve(),
      };
      for (const step of ['delete', 'from', 'where']) {
        builder[step] = () => builder;
      }
      const manager = {
        query,
        delete: jest.fn(),
        createQueryBuilder: () => builder,
      };
      const transactional = {
        transaction: (run: (m: unknown) => Promise<void>) => run(manager),
      } as unknown as DataSource;

      await makeService(0, null, 30, transactional).deleteAccount(5);

      expect(
        query.mock.calls.some(([sql]) =>
          (sql as string).includes('UPDATE "user"'),
        ),
      ).toBe(false);
    });

    it('writes no tombstone when the deletion does not commit', async () => {
      const transactional = {
        transaction: () => Promise.reject(new Error('rolled back')),
      } as unknown as DataSource;

      await expect(
        makeService(0, null, 30, transactional).deleteAccount(5),
      ).rejects.toThrow('rolled back');
      expect(cache.set).not.toHaveBeenCalled();
    });
  });

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
