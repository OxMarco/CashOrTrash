import { Queue } from 'bullmq';
import { getQueueToken } from '@nestjs/bullmq';

import {
  JOB_SCHEDULES,
  MAINTENANCE_QUEUE,
} from '../src/modules/jobs/jobs.constants';
import { Api } from './support/api-client';
import { playDaily, registerPlayer } from './support/players';
import { createTestApp, resetGameplayState, TestApp } from './support/test-app';

/**
 * Phase 7 and the cross-cutting parts of Phase 0: probes, error shape, push
 * registration and the scheduler topology. Individually small, collectively
 * the difference between a service that runs and one that can be operated.
 */
describe('platform surface', () => {
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

  describe('health probes', () => {
    /**
     * Liveness must not touch a dependency. If it did, a Postgres blip would
     * make the orchestrator kill every replica at once — turning a degraded
     * service into no service.
     */
    it('answers liveness without consulting anything', async () => {
      const response = await api.get('/health/live');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.uptimeSeconds).toEqual(expect.any(Number));
    });

    it('answers readiness with per-dependency detail', async () => {
      const response = await api.get('/health/ready');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(Object.keys(response.body.info)).toEqual(
        expect.arrayContaining(['database', 'redis', 'queue', 'catalogue']),
      );
    });

    it('leaves the probes outside the version prefix and the auth guard', async () => {
      // No token on either call above; and the versioned path must not exist.
      expect((await api.get('/v1/health/live')).status).toBe(404);
    });
  });

  describe('error responses', () => {
    it('describes a validation failure field by field', async () => {
      const player = await registerPlayer(api, 'platform-device-0001');

      const response = await player.api.post('/v1/sessions', { mode: 'bogus' });

      expect(response.status).toBe(400);
      expect(response.body.status).toBe(400);
      expect(response.body.title).toEqual(expect.any(String));
      expect(response.body.errors).toEqual(expect.any(Array));
    });

    it('rejects unknown properties rather than ignoring them', async () => {
      const player = await registerPlayer(api, 'platform-device-0002');

      const response = await player.api.post('/v1/sessions', {
        mode: 'daily',
        somethingElse: true,
      });

      expect(response.status).toBe(400);
    });

    it('returns a problem document for a missing resource', async () => {
      const player = await registerPlayer(api, 'platform-device-0003');

      const response = await player.api.get(
        '/v1/sessions/00000000-0000-4000-8000-000000000000/summary',
      );

      expect(response.status).toBe(404);
      expect(response.body.status).toBe(404);
      expect(response.body.type).toEqual(expect.any(String));
      expect(response.body.title).toEqual(expect.any(String));
      // The path that failed, so a support ticket carries it.
      expect(response.body.instance).toContain('/v1/sessions/');
    });

    it('rejects a malformed uuid before it reaches the service', async () => {
      const player = await registerPlayer(api, 'platform-device-0004');

      const response = await player.api.get('/v1/sessions/not-a-uuid/current');

      expect(response.status).toBe(400);
    });

    it('validates match ids as UUIDs too', async () => {
      const player = await registerPlayer(api, 'platform-device-match-uuid');

      const response = await player.api.get('/v1/matches/not-a-uuid');

      expect(response.status).toBe(400);
    });
  });

  describe('database integrity', () => {
    it('installs every named entity constraint and index', async () => {
      const expectedConstraints = ctx.dataSource.entityMetadatas.flatMap(
        (metadata) => [
          ...metadata.foreignKeys.map((foreignKey) => foreignKey.name),
          ...metadata.checks.map((check) => check.name),
        ],
      );
      const expectedIndexes = ctx.dataSource.entityMetadatas.flatMap(
        (metadata) => metadata.indices.map((index) => index.name),
      );
      const constraints: Array<{ name: string }> = await ctx.dataSource.query(
        `SELECT conname AS name
           FROM pg_constraint
           WHERE connamespace = current_schema()::regnamespace`,
      );
      const indexes: Array<{ name: string }> = await ctx.dataSource.query(
        `SELECT indexname AS name
         FROM pg_indexes
         WHERE schemaname = current_schema()`,
      );

      expect(constraints.map(({ name }) => name)).toEqual(
        expect.arrayContaining(expectedConstraints),
      );
      expect(indexes.map(({ name }) => name)).toEqual(
        expect.arrayContaining(expectedIndexes),
      );
    });

    it('rejects orphaned leaderboard rows', async () => {
      await expect(
        ctx.dataSource.query(
          `INSERT INTO daily_score ("userId", "challengeDate", score)
           VALUES ($1, CURRENT_DATE, 10)`,
          [2_147_483_647],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    // A test that re-ran the bootstrap seed over an edited catalogue and proved
    // it clobbered nothing lived here. There is no bootstrap seed now — the
    // catalogue is written only by the import job, whose own specs cover
    // re-running it — so there is nothing left for it to assert.
  });

  describe('push registration', () => {
    it('records an opt-in and is safe to repeat', async () => {
      const player = await registerPlayer(api, 'platform-device-0005', 'pushy');

      const first = await player.api.post('/v1/me/push', {
        platform: 'ios',
        token: 'platform-push-token-0001',
        timezoneOffsetMinutes: 120,
      });

      expect(first.status).toBe(200);
      expect(first.body.registered).toBe(true);
      expect(first.body.platform).toBe('ios');

      // The client re-registers on every launch; that must not accumulate rows.
      await player.api.post('/v1/me/push', {
        platform: 'ios',
        token: 'platform-push-token-0001',
        timezoneOffsetMinutes: 60,
      });

      const rows = await ctx.dataSource.query(
        'SELECT COUNT(*)::int AS count FROM push_token WHERE "userId" = $1',
        [player.userId],
      );
      expect(rows[0].count).toBe(1);
    });

    it('moves a token to the new player on a shared device', async () => {
      const first = await registerPlayer(
        api,
        'platform-device-0006',
        'sharera',
      );
      const second = await registerPlayer(
        api,
        'platform-device-0007',
        'sharerb',
      );
      const token = 'platform-push-token-0002';

      await first.api.post('/v1/me/push', { platform: 'android', token });
      await second.api.post('/v1/me/push', { platform: 'android', token });

      const rows = await ctx.dataSource.query(
        'SELECT "userId" FROM push_token WHERE token = $1',
        [token],
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].userId)).toBe(second.userId);
    });

    it('rejects an unknown platform', async () => {
      const player = await registerPlayer(api, 'platform-device-0008');

      const response = await player.api.post('/v1/me/push', {
        platform: 'blackberry',
        token: 'platform-push-token-0003',
      });

      expect(response.status).toBe(400);
    });

    it('requires a token — there is no anonymous opt-in', async () => {
      const response = await api.post('/v1/me/push', {
        platform: 'ios',
        token: 'platform-push-token-0004',
      });

      expect(response.status).toBe(401);
    });
  });

  describe('scheduling', () => {
    /**
     * Registered as BullMQ job schedulers rather than `@Cron()`, because
     * `@Cron()` fires on every replica: with three pods, tomorrow's challenge
     * would be generated three times and the nudge sent three times. The
     * scheduler id deduplicates that down to one tick, claimed by one worker.
     */
    it('registers one scheduler per job, and re-registering is a no-op', async () => {
      const queue = ctx.app.get<Queue>(getQueueToken(MAINTENANCE_QUEUE));

      const schedulers = await queue.getJobSchedulers();
      const names = schedulers.map((scheduler) => scheduler.key).sort();

      expect(names).toEqual(JOB_SCHEDULES.map((job) => job.name).sort());

      // Exactly what a second replica booting does.
      for (const { name, pattern } of JOB_SCHEDULES) {
        await queue.upsertJobScheduler(
          name,
          { pattern, tz: 'UTC' },
          { name, data: {} },
        );
      }

      expect(await queue.getJobSchedulers()).toHaveLength(JOB_SCHEDULES.length);
    });
  });

  describe('the profile card', () => {
    it('reports zeroes for a player who has not played', async () => {
      const player = await registerPlayer(api, 'platform-device-0009', 'fresh');

      const me = await player.api.get('/v1/me');

      expect(me.status).toBe(200);
      expect(me.body.username).toBe('fresh');
      expect(me.body.totalPoints).toBe(0);
      expect(me.body.bestRoundScore).toBe(0);
      expect(me.body.streakDays).toBe(0);
      expect(me.body.globalRank).toBeNull();
      // Never exposed, even to the player it belongs to.
      expect(me.raw).not.toContain('deviceId');
    });

    it('shows a rank once the player is on the board', async () => {
      const player = await registerPlayer(
        api,
        'platform-device-0010',
        'ranked',
      );
      await playDaily(player.api);

      const { waitFor } = await import('./support/wait');
      await waitFor(
        async () => (await player.api.get('/v1/me')).body.globalRank !== null,
        { label: 'the board to pick the score up' },
      );

      const me = await player.api.get('/v1/me');
      expect(me.body.globalRank).toBe(1);
    });
  });
});
