import { ConfigService } from '@nestjs/config';

import { AppConfig } from '../../src/config/configuration';
import { GameSession } from '../../src/modules/sessions/entities/game-session.entity';
import { hashDeviceId } from '../../src/modules/users/device-id';
import { Api } from '../support/api-client';
import { registerPlayer } from '../support/players';
import {
  createTestApp,
  resetGameplayState,
  TestApp,
} from '../support/test-app';

/**
 * Every limit in this API used to key on the caller's address, which is the
 * wrong unit twice over: it charges a whole office, school or mobile carrier
 * for one keen player, and it charges an account farm nothing at all, because
 * addresses are the one thing a farm has plenty of.
 *
 * The case that matters here is the first one — two accounts from one address
 * must not share a budget. It is also the only test that can prove the guard is
 * wired up at all: if `JwtAuthGuard` and `UserThrottlerGuard` ever swap places
 * in AppModule's providers, `req.user` is not set when the tracker reads it and
 * everything silently reverts to per-address. Nothing throws. Nothing logs.
 * This fails.
 */
describe('rate limiting', () => {
  let ctx: TestApp;
  let api: Api;
  let config: AppConfig;

  beforeAll(async () => {
    ctx = await createTestApp();
    api = ctx.api;
    config = ctx.app.get(ConfigService).getOrThrow<AppConfig>('app');
  });

  beforeEach(async () => {
    await resetGameplayState(ctx);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  /** `POST /sessions` carries its own budget: 30 a minute, per account. */
  const SESSION_BUDGET = 30;

  const startQuick = (player: { api: Api }) =>
    player.api.post('/v1/sessions', {
      mode: 'quick',
      themeSlug: 'mystery-mix',
    });

  describe('budgets follow the account, not the address', () => {
    it('does not let one player spend another’s session budget', async () => {
      const heavy = await registerPlayer(api, 'rate-device-0001', 'heavy');
      const quiet = await registerPlayer(api, 'rate-device-0002', 'quiet');

      // Both clients speak to the same replica from the same loopback address,
      // which under the old guard meant one shared bucket.
      let sawLimit = false;
      for (let attempt = 0; attempt < SESSION_BUDGET + 5; attempt++) {
        const response = await startQuick(heavy);
        if (response.status === 429) {
          sawLimit = true;
          break;
        }
      }
      expect(sawLimit).toBe(true);

      const untouched = await startQuick(quiet);
      expect(untouched.status).toBe(201);
    });

    it('answers an exhausted budget as a 429 problem document', async () => {
      const player = await registerPlayer(api, 'rate-device-0003', 'spender');

      let limited: { status: number; body: any } | null = null;
      for (let attempt = 0; attempt < SESSION_BUDGET + 5; attempt++) {
        const response = await startQuick(player);
        if (response.status === 429) {
          limited = response;
          break;
        }
      }

      expect(limited).not.toBeNull();
      expect(limited!.body.status).toBe(429);
    });
  });

  describe('the round budget', () => {
    /**
     * The throttler above caps requests; this caps rounds, which is the unit
     * that leaks — five reveals, five true prices. It must also run before the
     * previous session is retired, or being over budget would cost a player the
     * round they were in the middle of.
     */
    it('stops a third round and leaves the second one playable', async () => {
      const player = await registerPlayer(api, 'rate-device-0004', 'grinder');
      const original = config.quickSessionsPerHour;
      config.quickSessionsPerHour = 2;

      try {
        const first = await startQuick(player);
        const second = await startQuick(player);
        expect(first.status).toBe(201);
        expect(second.status).toBe(201);

        const third = await startQuick(player);
        expect(third.status).toBe(429);

        const survivor = await ctx.dataSource
          .getRepository(GameSession)
          .findOneOrFail({ where: { id: second.body.id as string } });
        expect(survivor.status).toBe('active');
      } finally {
        config.quickSessionsPerHour = original;
      }
    });

    it('does not stand in the way of the daily', async () => {
      const player = await registerPlayer(api, 'rate-device-0005', 'daily');
      const original = config.quickSessionsPerHour;
      config.quickSessionsPerHour = 1;

      try {
        expect((await startQuick(player)).status).toBe(201);
        expect((await startQuick(player)).status).toBe(429);

        const daily = await player.api.post('/v1/sessions', { mode: 'daily' });
        expect(daily.status).toBe(201);
      } finally {
        config.quickSessionsPerHour = original;
      }
    });

    /**
     * Head-to-head deals five items and reveals five prices exactly as a quick
     * round does, so it spends the same budget. Gating quick alone left the
     * cheaper door open: `POST /matches` allows twenty a minute, and each match
     * backs a five-round session — a ceiling written as thirty rounds an hour
     * was really thousands.
     */
    it('spends the same budget on a head-to-head as on a quick round', async () => {
      const host = await registerPlayer(api, 'rate-device-0006', 'hosting');
      const original = config.quickSessionsPerHour;
      config.quickSessionsPerHour = 1;

      try {
        expect((await startQuick(host)).status).toBe(201);

        const match = await host.api.post('/v1/matches', {
          themeSlug: 'everyday-stuff',
        });
        expect(match.status).toBe(201);

        const session = await host.api.post('/v1/sessions', {
          mode: 'h2h',
          inviteCode: match.body.inviteCode,
        });
        expect(session.status).toBe(429);
      } finally {
        config.quickSessionsPerHour = original;
      }
    });

    /**
     * Rejoining is not being dealt anything: the five items already exist and
     * the session is returned, not created. Charging for it would strand a
     * player mid-match behind a limit they cannot wait out without losing it.
     */
    it('lets a player back into a match already under way, over budget or not', async () => {
      const host = await registerPlayer(api, 'rate-device-0007', 'rejoiner');
      const original = config.quickSessionsPerHour;

      try {
        const match = await host.api.post('/v1/matches', {
          themeSlug: 'everyday-stuff',
        });
        expect(match.status).toBe(201);

        const first = await host.api.post('/v1/sessions', {
          mode: 'h2h',
          inviteCode: match.body.inviteCode,
        });
        expect(first.status).toBe(201);

        // Now over budget, with a match in progress.
        config.quickSessionsPerHour = 1;
        const resumed = await host.api.post('/v1/sessions', {
          mode: 'h2h',
          inviteCode: match.body.inviteCode,
        });

        expect(resumed.status).toBe(201);
        expect(resumed.body.resumed).toBe(true);
        expect(resumed.body.id).toBe(first.body.id);
      } finally {
        config.quickSessionsPerHour = original;
      }
    });
  });

  describe('minting accounts', () => {
    /**
     * The leaderboard's defence against a throwaway account is a 24-hour age
     * gate, which a patient farm beats by registering the day before. This is
     * the budget over that same window.
     */
    it('caps how many new accounts one address can register in a day', async () => {
      const original = config.accountsPerIpPerDay;
      config.accountsPerIpPerDay = 2;

      try {
        for (let n = 0; n < 2; n++) {
          const response = await api.post('/v1/auth/anonymous', {
            deviceId: `mint-device-${n}`,
          });
          expect(response.status).toBe(200);
        }

        const refused = await api.post('/v1/auth/anonymous', {
          deviceId: 'mint-device-over-budget',
        });
        expect(refused.status).toBe(429);
        expect(refused.body.status).toBe(429);
      } finally {
        config.accountsPerIpPerDay = original;
      }
    });

    /**
     * The common case, and the one that must never be refused: a player
     * reopening the app is not registering, so it costs the address nothing.
     */
    it('lets a known device back in after the budget is gone', async () => {
      const original = config.accountsPerIpPerDay;
      config.accountsPerIpPerDay = 1;

      try {
        const first = await api.post('/v1/auth/anonymous', {
          deviceId: 'returning-device',
        });
        expect(first.status).toBe(200);

        expect(
          (await api.post('/v1/auth/anonymous', { deviceId: 'a-new-device' }))
            .status,
        ).toBe(429);

        // Same device, well past the budget. Still welcome.
        const again = await api.post('/v1/auth/anonymous', {
          deviceId: 'returning-device',
        });
        expect(again.status).toBe(200);
        expect(again.body.accessToken).toBeTruthy();
      } finally {
        config.accountsPerIpPerDay = original;
      }
    });

    it('charges concurrent retries for one device only once', async () => {
      const original = config.accountsPerIpPerDay;
      config.accountsPerIpPerDay = 1;

      try {
        const retries = await Promise.all(
          Array.from({ length: 8 }, () =>
            api.post('/v1/auth/anonymous', {
              deviceId: 'one-racing-device',
            }),
          ),
        );
        expect(retries.every((response) => response.status === 200)).toBe(true);

        const distinct = await api.post('/v1/auth/anonymous', {
          deviceId: 'second-distinct-device',
        });
        expect(distinct.status).toBe(429);
      } finally {
        config.accountsPerIpPerDay = original;
      }
    });

    it('records where an account was registered from', async () => {
      await registerPlayer(api, 'rate-device-0006', 'traced');

      const [row] = await ctx.dataSource.query(
        'SELECT "registrationIp" FROM "user" WHERE "deviceIdHash" = $1',
        [hashDeviceId('rate-device-0006')],
      );

      expect(row.registrationIp).toBeTruthy();
    });

    /**
     * The device id is the account's credential; the table keeps only its
     * digest. Asserted against the SQL expression the hashing migration uses,
     * so the application's digest and the one written over pre-existing rows
     * are proven to be the same function — if they ever drifted, every player
     * migrated in place would register as a stranger on their next launch.
     */
    it('stores the device id only as the digest the migration computes', async () => {
      await registerPlayer(api, 'rate-device-0007', 'hashed');

      const rows = await ctx.dataSource.query(
        `SELECT "deviceIdHash" FROM "user"
          WHERE "deviceIdHash" = encode(sha256(convert_to($1::text, 'UTF8')), 'hex')`,
        ['rate-device-0007'],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].deviceIdHash).toBe(hashDeviceId('rate-device-0007'));
      expect(rows[0].deviceIdHash).not.toContain('rate-device');
    });
  });
});
