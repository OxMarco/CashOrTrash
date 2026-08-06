import { Api } from './support/api-client';
import { registerPlayer } from './support/players';
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

    it('issues a fresh pair for a refresh token', async () => {
      const auth = await api.post('/v1/auth/anonymous', {
        deviceId: 'onboard-device-0002',
      });

      const refreshed = await api.post('/v1/auth/refresh', {
        refreshToken: auth.body.refreshToken,
      });

      expect(refreshed.status).toBe(200);
      expect(refreshed.body.accessToken).toEqual(expect.any(String));
      expect(refreshed.body.isNewPlayer).toBe(false);
    });

    /**
     * The two token kinds are signed with different secrets *and* carry a
     * `typ` claim. Either alone would stop this; both is deliberate.
     */
    it('refuses to accept an access token as a refresh token', async () => {
      const auth = await api.post('/v1/auth/anonymous', {
        deviceId: 'onboard-device-0003',
      });

      const response = await api.post('/v1/auth/refresh', {
        refreshToken: auth.body.accessToken,
      });

      expect(response.status).toBe(401);
    });

    it('refuses a refresh token as a bearer credential', async () => {
      const auth = await api.post('/v1/auth/anonymous', {
        deviceId: 'onboard-device-0004',
      });

      const response = await api.as(auth.body.refreshToken).get('/v1/me');

      expect(response.status).toBe(401);
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
});
