import { todayUtc } from '../src/common/utils/date.util';
import { Api } from './support/api-client';
import { playDaily, registerPlayer } from './support/players';
import { createTestApp, resetGameplayState, TestApp } from './support/test-app';
import { waitFor } from './support/wait';

/**
 * The friends board was previously a scope the API advertised and nothing
 * could populate — `?scope=friends` read a table with no writer. These cases
 * cover the write side and, at the end, prove the two actually meet.
 */
describe('friends', () => {
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

  describe('adding', () => {
    it('creates a mutual friendship from one request', async () => {
      const sam = await registerPlayer(api, 'friend-device-0001', 'sam');
      const maria = await registerPlayer(api, 'friend-device-0002', 'maria');

      const added = await sam.api.post('/v1/friends', { username: 'maria' });

      expect(added.status).toBe(200);
      expect(added.body.userId).toBe(maria.userId);
      expect(added.body.username).toBe('maria');
      expect(added.body.avatarSeed).toEqual(expect.any(String));
      expect(added.body.friendsSince).toEqual(expect.any(String));

      // Mutual: Maria did not have to accept, and sees Sam immediately.
      const hers = await maria.api.get('/v1/friends');
      expect(hers.body.count).toBe(1);
      expect(hers.body.friends[0].userId).toBe(sam.userId);

      // Stored as two rows, which is what makes the board a single-column
      // lookup rather than an OR across both sides.
      const [row] = await ctx.dataSource.query(
        'SELECT COUNT(*)::int AS count FROM friendship',
      );
      expect(row.count).toBe(2);
    });

    it('matches the handle regardless of the case typed', async () => {
      const sam = await registerPlayer(api, 'friend-device-0003', 'sam');
      await registerPlayer(api, 'friend-device-0004', 'maria');

      const added = await sam.api.post('/v1/friends', { username: 'MaRiA' });

      expect(added.status).toBe(200);
      expect(added.body.username).toBe('maria');
    });

    /** A retried tap on a flaky connection must not become an error. */
    it('is idempotent', async () => {
      const sam = await registerPlayer(api, 'friend-device-0005', 'sam');
      await registerPlayer(api, 'friend-device-0006', 'maria');

      const first = await sam.api.post('/v1/friends', { username: 'maria' });
      const second = await sam.api.post('/v1/friends', { username: 'maria' });

      expect(second.status).toBe(200);
      expect(second.body.userId).toBe(first.body.userId);
      // Unchanged, so the original friendship was not replaced.
      expect(second.body.friendsSince).toBe(first.body.friendsSince);

      const [row] = await ctx.dataSource.query(
        'SELECT COUNT(*)::int AS count FROM friendship',
      );
      expect(row.count).toBe(2);
    });

    it('survives both players adding each other at the same moment', async () => {
      const sam = await registerPlayer(api, 'friend-device-0007', 'sam');
      const maria = await registerPlayer(api, 'friend-device-0008', 'maria');

      const results = await Promise.all([
        sam.api.post('/v1/friends', { username: 'maria' }),
        maria.api.post('/v1/friends', { username: 'sam' }),
      ]);

      for (const result of results) expect(result.status).toBe(200);

      const [row] = await ctx.dataSource.query(
        'SELECT COUNT(*)::int AS count FROM friendship',
      );
      expect(row.count).toBe(2);
    });

    it('rejects adding yourself', async () => {
      const sam = await registerPlayer(api, 'friend-device-0009', 'sam');

      const response = await sam.api.post('/v1/friends', { username: 'sam' });

      expect(response.status).toBe(400);
    });

    it('404s an unknown handle', async () => {
      const sam = await registerPlayer(api, 'friend-device-0010', 'sam');

      const response = await sam.api.post('/v1/friends', {
        username: 'nobodyhere',
      });

      expect(response.status).toBe(404);
    });

    it('rejects an empty handle before it reaches the lookup', async () => {
      const sam = await registerPlayer(api, 'friend-device-0011', 'sam');
      // A player who never claimed a username has `username IS NULL` and so is
      // unreachable by definition; the guard that matters is that a blank
      // handle never becomes a query that could match one of them.
      await registerPlayer(api, 'friend-device-0012');

      const response = await sam.api.post('/v1/friends', { username: '' });

      expect(response.status).toBe(400);
    });

    it('requires a token', async () => {
      const response = await api.post('/v1/friends', { username: 'sam' });

      expect(response.status).toBe(401);
    });
  });

  describe('listing', () => {
    it('starts empty and returns friends newest first', async () => {
      const sam = await registerPlayer(api, 'friend-device-0013', 'sam');
      await registerPlayer(api, 'friend-device-0014', 'maria');
      await registerPlayer(api, 'friend-device-0015', 'linus');

      const empty = await sam.api.get('/v1/friends');
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual({ friends: [], count: 0 });

      await sam.api.post('/v1/friends', { username: 'maria' });
      await sam.api.post('/v1/friends', { username: 'linus' });

      const listed = await sam.api.get('/v1/friends');
      expect(listed.body.count).toBe(2);
      expect(listed.body.friends.map((f: any) => f.username)).toEqual([
        'linus',
        'maria',
      ]);
    });

    it('carries the stats the friends screen renders', async () => {
      const sam = await registerPlayer(api, 'friend-device-0016', 'sam');
      const maria = await registerPlayer(api, 'friend-device-0017', 'maria');
      const played = await playDaily(maria.api);

      await sam.api.post('/v1/friends', { username: 'maria' });
      const listed = await sam.api.get('/v1/friends');

      const [friend] = listed.body.friends;
      expect(friend.totalPoints).toBe(played.totalScore);
      expect(friend.streakDays).toBe(1);
      // Never the friend's device id, however friendly they are.
      expect(listed.raw).not.toContain('deviceId');
    });
  });

  describe('removing', () => {
    it('drops both directions', async () => {
      const sam = await registerPlayer(api, 'friend-device-0018', 'sam');
      const maria = await registerPlayer(api, 'friend-device-0019', 'maria');
      await sam.api.post('/v1/friends', { username: 'maria' });

      const response = await sam.api.del(`/v1/friends/${maria.userId}`);
      expect(response.status).toBe(204);
      expect(response.raw).toBe('');

      expect((await sam.api.get('/v1/friends')).body.count).toBe(0);
      // The other side goes too — otherwise Maria keeps Sam on her board.
      expect((await maria.api.get('/v1/friends')).body.count).toBe(0);
    });

    it('succeeds whether or not they were a friend', async () => {
      const sam = await registerPlayer(api, 'friend-device-0020', 'sam');
      const stranger = await registerPlayer(api, 'friend-device-0021', 'stray');

      const response = await sam.api.del(`/v1/friends/${stranger.userId}`);

      expect(response.status).toBe(204);
    });
  });

  describe('the friends leaderboard', () => {
    /**
     * The point of the whole feature: what the write side records is what
     * `?scope=friends` reads.
     */
    it('shows exactly the player and the friends they added', async () => {
      const sam = await registerPlayer(api, 'friend-device-0022', 'sam');
      const maria = await registerPlayer(api, 'friend-device-0023', 'maria');
      const stranger = await registerPlayer(api, 'friend-device-0024', 'stray');

      for (const player of [sam, maria, stranger]) await playDaily(player.api);
      await waitFor(
        async () => {
          const [row] = await ctx.dataSource.query(
            'SELECT COUNT(*)::int AS count FROM daily_score WHERE "challengeDate" = $1',
            [todayUtc()],
          );
          return row.count === 3;
        },
        { label: 'three scores on today’s board' },
      );

      const before = await sam.api.get('/v1/leaderboard?scope=friends');
      expect(before.body.rows.map((r: any) => r.userId)).toEqual([sam.userId]);

      await sam.api.post('/v1/friends', { username: 'maria' });

      const after = await sam.api.get('/v1/leaderboard?scope=friends');
      const ids = after.body.rows.map((r: any) => r.userId).sort();
      expect(ids).toEqual([sam.userId, maria.userId].sort());
      expect(ids).not.toContain(stranger.userId);

      // And it reflects a removal just as promptly.
      await sam.api.del(`/v1/friends/${maria.userId}`);

      const removed = await sam.api.get('/v1/leaderboard?scope=friends');
      expect(removed.body.rows.map((r: any) => r.userId)).toEqual([sam.userId]);
    });
  });
});
