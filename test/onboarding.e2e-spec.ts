import { Api } from './support/api-client';
import { registerPlayer } from './support/players';
import { waitFor } from './support/wait';
import { createTestApp, resetGameplayState, TestApp } from './support/test-app';

/**
 * Phase 2 exit criterion: onboarding end to end, including two clients racing
 * for the same username. The race is the interesting half — uniqueness is
 * enforced by a partial unique index on a `citext` column, and the only way to
 * prove that is to make two requests collide for real.
 */
describe('onboarding', () => {
  let ctx: TestApp;
  let api: Api;

  beforeAll(async () => {
    ctx = await createTestApp();
    api = ctx.api;
  });

  beforeEach(async () => {
    await resetGameplayState(ctx);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  describe('anonymous device auth', () => {
    it('registers on first sight and recognises the device after that', async () => {
      const first = await api.post('/v1/auth/anonymous', {
        deviceId: 'onboard-device-0001',
      });

      expect(first.status).toBe(200);
      expect(first.body.isNewPlayer).toBe(true);
      expect(first.body.accessToken).toEqual(expect.any(String));
      expect(first.body.username).toBeNull();

      const second = await api.post('/v1/auth/anonymous', {
        deviceId: 'onboard-device-0001',
      });

      expect(second.body.isNewPlayer).toBe(false);
    });

    it('rejects a device id that is not url-safe', async () => {
      const response = await api.post('/v1/auth/anonymous', {
        deviceId: 'has spaces and/slashes',
      });

      expect(response.status).toBe(400);
    });

    it('requires a token for the authenticated surface', async () => {
      expect((await api.get('/v1/home')).status).toBe(401);
      expect((await api.get('/v1/me')).status).toBe(401);
    });
  });

  describe('username availability', () => {
    it('answers without a token, because onboarding has none yet', async () => {
      const response = await api.get('/v1/usernames/availability?u=freshname');

      expect(response.status).toBe(200);
      expect(response.body.available).toBe(true);
      expect(response.body.normalised).toBe('freshname');
    });

    it.each([
      ['admin', 'reserved', 'username-not-allowed'],
      ['ab', 'too short', 'username-invalid'],
      ['f.u.c.k', 'profanity behind separators', 'username-not-allowed'],
      ['fvckyou', 'profanity behind a substitution', 'username-not-allowed'],
    ])('rejects %s (%s)', async (candidate, _case, code) => {
      const response = await api.get(
        `/v1/usernames/availability?u=${encodeURIComponent(candidate)}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.available).toBe(false);
      expect(response.body.reason).toEqual(expect.any(String));
      expect(response.body.code).toBe(code);
    });

    // A substring filter rejects all three; the player whose handle is
    // `classiccars` only finds out that it did when they cannot claim it.
    it.each(['classiccars', 'bassmaster', 'assistant'])(
      'does not mistake %s for profanity',
      async (candidate) => {
        const response = await api.get(
          `/v1/usernames/availability?u=${candidate}`,
        );

        expect(response.body.available).toBe(true);
      },
    );

    it('reports a claimed name as taken regardless of case', async () => {
      await registerPlayer(api, 'onboard-device-0005', 'Sam');

      const response = await api.get('/v1/usernames/availability?u=SAM');

      expect(response.body.available).toBe(false);
      expect(response.body.code).toBe('username-taken');
    });
  });

  describe('claiming a username', () => {
    it('normalises to lower case and returns the profile', async () => {
      const player = await registerPlayer(api, 'onboard-device-0006');

      const response = await player.api.post('/v1/me/username', {
        username: 'MixedCase',
      });

      expect(response.status).toBe(200);
      expect(response.body.username).toBe('mixedcase');
      expect(response.body.avatarSeed).toEqual(expect.any(String));
      expect(response.body.totalPoints).toBe(0);
      expect(response.body.streakDays).toBe(0);
    });

    /**
     * Phase 2 exit criterion proper. Both requests are in flight before either
     * commits, so this exercises the index rather than a read-then-write check
     * that would simply not race.
     */
    it('lets exactly one of two racing clients take the name', async () => {
      const [alice, bob] = await Promise.all([
        registerPlayer(api, 'race-device-0001'),
        registerPlayer(api, 'race-device-0002'),
      ]);

      const results = await Promise.all([
        alice.api.post('/v1/me/username', { username: 'contested' }),
        bob.api.post('/v1/me/username', { username: 'CONTESTED' }),
      ]);

      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409]);

      const winner = results.find((r) => r.status === 200)!;
      expect(winner.body.username).toBe('contested');

      const holders = await ctx.dataSource.query(
        'SELECT COUNT(*)::int AS count FROM "user" WHERE username = $1',
        ['contested'],
      );
      expect(holders[0].count).toBe(1);
    });

    it('lets a player keep changing their own name', async () => {
      const player = await registerPlayer(
        api,
        'onboard-device-0007',
        'firstname',
      );

      const renamed = await player.api.post('/v1/me/username', {
        username: 'secondname',
      });

      expect(renamed.status).toBe(200);
      expect(renamed.body.username).toBe('secondname');

      // The old handle is released, not squatted forever.
      const availability = await api.get(
        '/v1/usernames/availability?u=firstname',
      );
      expect(availability.body.available).toBe(true);
    });

    it('rejects a reserved name at the write path, not just the probe', async () => {
      const player = await registerPlayer(api, 'onboard-device-0008');

      const response = await player.api.post('/v1/me/username', {
        username: 'admin',
      });

      expect(response.status).toBe(400);
      expect(response.body.type).toBe('username-not-allowed');
    });

    /**
     * The probe is advisory — nothing stops a client from skipping it — so the
     * write path runs the same filter, and answers reserved and profane with
     * one indistinguishable code.
     */
    it('rejects a vulgar name at the write path', async () => {
      const player = await registerPlayer(api, 'onboard-device-0009');

      const response = await player.api.post('/v1/me/username', {
        username: 'sh1thead',
      });

      expect(response.status).toBe(400);
      expect(response.body.type).toBe('username-not-allowed');
    });

    it('tells a client that lost the name apart from one that was refused it', async () => {
      await registerPlayer(api, 'onboard-device-0010', 'holder');
      const latecomer = await registerPlayer(api, 'onboard-device-0011');

      const response = await latecomer.api.post('/v1/me/username', {
        username: 'holder',
      });

      expect(response.status).toBe(409);
      expect(response.body.type).toBe('username-taken');
    });
  });

  describe('account deletion', () => {
    it('removes the player, their dependent rows, and cached leaderboard entry', async () => {
      const player = await registerPlayer(
        api,
        'delete-device-0001',
        'deleteme',
      );
      await player.api.post('/v1/me/push', {
        platform: 'ios',
        token: 'ExponentPushToken[delete-me-account-test]',
        timezoneOffsetMinutes: 60,
      });
      await ctx.dataSource.query(
        `INSERT INTO daily_score ("userId", "challengeDate", score)
         VALUES ($1, CURRENT_DATE, 123)`,
        [player.userId],
      );
      const member = String(player.userId).padStart(10, '0');
      await ctx.redis.zadd('lb:daily:2099-01-01', 123, member);

      const response = await player.api.del('/v1/me');

      expect(response.status).toBe(204);
      expect(
        await ctx.dataSource.query('SELECT id FROM "user" WHERE id = $1', [
          player.userId,
        ]),
      ).toEqual([]);
      expect(
        await ctx.dataSource.query(
          'SELECT id FROM push_token WHERE "userId" = $1',
          [player.userId],
        ),
      ).toEqual([]);
      expect(
        await ctx.dataSource.query(
          'SELECT "userId" FROM daily_score WHERE "userId" = $1',
          [player.userId],
        ),
      ).toEqual([]);
      expect(await ctx.redis.zscore('lb:daily:2099-01-01', member)).toBeNull();

      // A previously issued access credential no longer resolves.
      expect((await player.api.get('/v1/me')).status).toBe(401);

      // The local installation may choose to start over with a new anonymous
      // identity; the deleted handle and device id are no longer retained.
      const recreated = await api.post('/v1/auth/anonymous', {
        deviceId: player.deviceId,
      });
      expect(recreated.status).toBe(200);
      expect(recreated.body.isNewPlayer).toBe(true);
    });

    // A bet locks user → session → match. Deletion must take the opponent's
    // session before the match it shares, or an opponent mid-bet (holding its
    // session, waiting on the match) and the deletion (holding the match,
    // waiting on that session) deadlock.
    it('locks the shared sessions before the match, as a bet does', async () => {
      const host = await registerPlayer(api, 'delete-lock-order-host');
      const guest = await registerPlayer(api, 'delete-lock-order-guest');
      const match = await host.api.post('/v1/matches', {
        themeSlug: 'vintage-finds',
      });
      const inviteCode = match.body.inviteCode as string;
      await guest.api.post('/v1/matches/join', { inviteCode });
      await host.api.post('/v1/sessions', { mode: 'h2h', inviteCode });
      const guestSession = await guest.api.post('/v1/sessions', {
        mode: 'h2h',
        inviteCode,
      });

      // Stand in for the guest's bet at the point it holds its session.
      const bet = ctx.dataSource.createQueryRunner();
      await bet.connect();
      await bet.startTransaction();
      let deletion: ReturnType<typeof host.api.del> | undefined;
      try {
        await bet.query(
          'SELECT id FROM game_session WHERE id = $1 FOR UPDATE',
          [guestSession.body.id],
        );
        deletion = host.api.del('/v1/me');

        await waitFor(
          async () => {
            const [row] = await ctx.dataSource.query<
              Array<{ waiting: number }>
            >(
              `SELECT COUNT(*)::int AS waiting FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
                  AND query LIKE '%game_session%'`,
            );
            return row.waiting > 0;
          },
          { label: 'deletion waiting for the opponent session' },
        );

        // The bet's next step: the match. The deletion must not be holding it.
        await expect(
          bet.query('SELECT id FROM "match" WHERE id = $1 FOR UPDATE NOWAIT', [
            match.body.id,
          ]),
        ).resolves.toHaveLength(1);
        await bet.commitTransaction();

        expect((await deletion).status).toBe(204);
      } finally {
        if (bet.isTransactionActive) await bet.rollbackTransaction();
        await bet.release();
        // Settle the request on failure too, or it outlives the suite.
        await deletion?.catch(() => undefined);
      }
    });

    it('survives a bet racing the deletion of its opponent', async () => {
      const host = await registerPlayer(api, 'delete-race-host');
      const guest = await registerPlayer(api, 'delete-race-guest');
      const match = await host.api.post('/v1/matches', {
        themeSlug: 'vintage-finds',
      });
      const inviteCode = match.body.inviteCode as string;
      await guest.api.post('/v1/matches/join', { inviteCode });
      await host.api.post('/v1/sessions', { mode: 'h2h', inviteCode });
      const session = await guest.api.post('/v1/sessions', {
        mode: 'h2h',
        inviteCode,
      });
      const current = await guest.api.get(
        `/v1/sessions/${session.body.id}/current`,
      );

      const [bet, deletion] = await Promise.all([
        guest.api.post(`/v1/sessions/${session.body.id}/rounds/0/bet`, {
          loCents: current.body.suggestedLoCents,
          hiCents: current.body.suggestedHiCents,
        }),
        host.api.del('/v1/me'),
      ]);

      expect(deletion.status).toBe(204);
      // Either order is legal; a deadlock surfaces as a 500 instead.
      expect([200, 404]).toContain(bet.status);
    });
  });
});
