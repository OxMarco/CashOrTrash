import { addDays, todayUtc } from '../src/common/utils/date.util';
import {
  boardReadyKey,
  dailyKey,
  weekKey,
} from '../src/modules/leaderboard/leaderboard.keys';
import { LeaderboardService } from '../src/modules/leaderboard/leaderboard.service';
import { Api } from './support/api-client';
import { playDaily, registerPlayer } from './support/players';
import { createTestApp, resetGameplayState, TestApp } from './support/test-app';
import { waitFor } from './support/wait';

/**
 * Phase 5 exit criteria: Redis ranks and percentiles agree with a Postgres
 * `ROW_NUMBER()` cross-check, and `leaderboard-rebuild` restores the board
 * after a Redis flush.
 *
 * The topology is deliberate — Postgres is authoritative and Redis is a
 * rebuildable serving layer — so the tests that matter are the ones proving
 * the two never disagree and that losing the fast one loses nothing.
 */
describe('leaderboard', () => {
  let ctx: TestApp;
  let api: Api;
  let leaderboard: LeaderboardService;

  beforeAll(async () => {
    ctx = await createTestApp();
    api = ctx.api;
    leaderboard = ctx.app.get(LeaderboardService);
  });

  beforeEach(async () => {
    await resetGameplayState(ctx);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  /** Plays a full daily for each name, then verifies both serving stores. */
  const playField = async (names: string[]) => {
    const players = [];
    for (const [index, name] of names.entries()) {
      const player = await registerPlayer(
        api,
        `lb-device-${name}-${index}`,
        name,
      );
      const result = await playDaily(player.api);
      players.push({ ...player, totalScore: result.totalScore });
    }

    // PostgreSQL commits with the final bet; the awaited completion listener
    // mirrors the row to Redis before that response returns. The poll also
    // tolerates CI scheduling latency without encoding it into every test.
    await waitFor(
      async () => {
        const [row] = await ctx.dataSource.query(
          'SELECT COUNT(*)::int AS count FROM daily_score WHERE "challengeDate" = $1',
          [todayUtc()],
        );
        const ranked = await ctx.redis.zcard(dailyKey(todayUtc()));
        return row.count === names.length && ranked === names.length;
      },
      { label: `${names.length} scores on today’s board` },
    );

    return players;
  };

  it('ranks a field and agrees with Postgres row for row', async () => {
    await playField(['ada', 'grace', 'linus', 'margaret']);

    const fromPostgres = await leaderboard.ranksFromPostgres(todayUtc());
    expect(fromPostgres).toHaveLength(4);

    // Every player's Redis rank must match the authoritative ordering.
    for (const row of fromPostgres) {
      const redisRank = await leaderboard.getRank('today', row.userId);
      expect({ userId: row.userId, rank: redisRank }).toEqual({
        userId: row.userId,
        rank: row.rank,
      });
    }
  });

  /**
   * Ties are where a cache and its source of truth usually part company, and
   * where they part company *consistently* rather than randomly — so a bug
   * here looks like "the leaderboard is occasionally off by one" rather than
   * like a bug. A tie shares a rank in both stores, and the *row order* of
   * a tie — which Redis reads through `ZREV*`, returning equal scores in
   * descending member order — is what Postgres has to be told to match.
   */
  it('shares a rank across a tie, and orders the tie the same way in both stores', async () => {
    const players = await playField(['tiea', 'tieb', 'tiec']);
    const date = todayUtc();

    // Force an exact three-way tie through the authoritative store, then
    // rebuild the serving layer from it.
    for (const player of players) {
      await setScore(ctx, player.userId, date, 500);
    }
    await leaderboard.rebuild('today');

    const fromPostgres = await leaderboard.ranksFromPostgres(date);
    expect(fromPostgres.map((row) => row.rank)).toEqual([1, 1, 1]);
    for (const row of fromPostgres) {
      expect(await leaderboard.getRank('today', row.userId)).toBe(1);
    }

    // The rows of the tie come out in descending user id, because every read
    // goes through ZREVRANGE and that is the order it produces over padded
    // members — and the served board must show them the same way.
    expect(fromPostgres.map((row) => row.userId)).toEqual(
      [...fromPostgres]
        .sort((a, b) => b.userId - a.userId)
        .map((row) => row.userId),
    );
    const board = await players[0].api.get('/v1/leaderboard?scope=today');
    expect(board.status).toBe(200);
    expect(board.body.podium.map((row: any) => row.rank)).toEqual([1, 1, 1]);
    expect(board.body.me.rank).toBe(1);
    // Nobody beaten, but nobody ahead either.
    expect(board.body.me.percentile).toBe(0);
  });

  it('serves a board with a podium, the player’s own row and a percentile', async () => {
    const players = await playField(['boarda', 'boardb', 'boardc']);
    const me = players[0];

    const response = await me.api.get('/v1/leaderboard?scope=today');

    expect(response.status).toBe(200);
    expect(response.body.scope).toBe('today');
    expect(response.body.totalPlayers).toBe(3);
    expect(response.body.rows).toHaveLength(3);
    expect(response.body.podium).toHaveLength(3);

    // Descending by score, and self-identifying.
    const scores = response.body.rows.map((row: any) => row.score);
    expect([...scores].sort((a: number, b: number) => b - a)).toEqual(scores);
    expect(response.body.rows.filter((row: any) => row.isMe)).toHaveLength(1);

    expect(response.body.me.rank).toBeGreaterThanOrEqual(1);
    expect(response.body.me.percentile).toBeGreaterThanOrEqual(0);
    expect(response.body.me.percentile).toBeLessThanOrEqual(100);
    expect(response.body.rows[0].username).toEqual(expect.any(String));
  });

  it('places an unranked player on the board without a rank', async () => {
    await playField(['ranked']);
    const lurker = await registerPlayer(api, 'lb-device-lurker', 'lurker');

    const response = await lurker.api.get('/v1/leaderboard?scope=today');

    expect(response.status).toBe(200);
    expect(response.body.me.rank).toBeNull();
    expect(response.body.me.score).toBe(0);
    expect(response.body.me.percentile).toBeNull();
  });

  it('reports percentile consistently with the Postgres ordering', async () => {
    const players = await playField(['pcta', 'pctb', 'pctc', 'pctd']);
    const fromPostgres = await leaderboard.ranksFromPostgres(todayUtc());
    const total = fromPostgres.length;

    for (const player of players) {
      const row = fromPostgres.find((r) => r.userId === player.userId)!;
      const beaten = fromPostgres.filter((r) => r.score < row.score).length;

      // Measured against the *other* players: the top of a field of four has
      // beaten all three of them, not 75% of four.
      expect(await leaderboard.getPercentile('today', player.userId)).toBe(
        Math.round((beaten / (total - 1)) * 100),
      );
    }
  });

  it('reads an expired historical percentile from Postgres', async () => {
    const players = await playField(['historya', 'historyb', 'historyc']);
    const yesterday = addDays(todayUtc(), -1);

    await leaderboard.persistDailyScore(players[0].userId, yesterday, 100);
    await leaderboard.persistDailyScore(players[1].userId, yesterday, 200);
    await leaderboard.persistDailyScore(players[2].userId, yesterday, 300);

    // A historical summary must not depend on its short-lived Redis key.
    await ctx.redis.del(dailyKey(yesterday));

    expect(
      await leaderboard.getDailyStanding(players[0].userId, yesterday),
    ).toEqual({ rank: 3, sharedWith: 0, percentile: 0 });
    expect(
      await leaderboard.getDailyStanding(players[2].userId, yesterday),
    ).toEqual({ rank: 1, sharedWith: 0, percentile: 100 });
  });

  // The summary is fetched the instant the last bet lands, and the Redis
  // mirror of the score arrives by an async event a beat later. The row is
  // already there; the standing has to come from it rather than be null.
  it('reports today’s standing from the row while the Redis mirror is behind', async () => {
    const players = await playField(['racea', 'raceb']);
    const today = todayUtc();
    await ctx.redis.zrem(
      dailyKey(today),
      ...players.map((p) => String(p.userId).padStart(10, '0')),
    );

    const standing = await leaderboard.getDailyStanding(
      players[0].userId,
      today,
    );
    expect(standing).not.toBeNull();
    expect(standing!.rank).toBeGreaterThanOrEqual(1);
    expect(standing!.sharedWith + 1).toBeLessThanOrEqual(2);
  });

  describe('the weekly board', () => {
    it('totals a player’s daily scores rather than incrementing blindly', async () => {
      const player = await registerPlayer(api, 'lb-device-weekly', 'weekly');
      const played = await playDaily(player.api);

      await waitFor(
        async () => (await leaderboard.getRank('week', player.userId)) !== null,
        { label: 'the weekly board to pick the score up' },
      );

      const week = await player.api.get('/v1/leaderboard?scope=week');
      expect(week.body.me.score).toBe(played.totalScore);

      // A replayed bet must not inflate the week: the weekly total is
      // recomputed from `daily_score`, never incremented.
      const replay = await player.api.post(
        `/v1/sessions/${played.sessionId}/rounds/0/bet`,
        { loCents: 0, hiCents: 1 },
      );
      expect(replay.body.replayed).toBe(true);

      const after = await player.api.get('/v1/leaderboard?scope=week');
      expect(after.body.me.score).toBe(played.totalScore);
    });
  });

  const setScore = (
    app: TestApp,
    userId: number,
    date: string,
    score: number,
  ): Promise<unknown> =>
    app.dataSource.query(
      'UPDATE daily_score SET score = $3 WHERE "userId" = $1 AND "challengeDate" = $2',
      [userId, date, score],
    );

  describe('the friends board', () => {
    it('shows only the player and their friends', async () => {
      const [a, b, c] = await playField(['frienda', 'friendb', 'strangerc']);

      // Stored in both directions, so the friends board is a single-column
      // lookup rather than an OR across two.
      await ctx.dataSource.query(
        `INSERT INTO friendship ("userId", "friendUserId") VALUES ($1, $2), ($2, $1)`,
        [a.userId, b.userId],
      );

      const response = await a.api.get('/v1/leaderboard?scope=friends');

      expect(response.status).toBe(200);
      const ids = response.body.rows.map((row: any) => row.userId).sort();
      expect(ids).toEqual([a.userId, b.userId].sort());
      expect(ids).not.toContain(c.userId);
    });
  });

  describe('recovery', () => {
    /**
     * The Phase 5 exit criterion, and the reason Redis is allowed to be a
     * cache at all: flushing it must cost latency, never scores.
     */
    it('rebuilds the board from Postgres after a Redis flush', async () => {
      const players = await playField(['reba', 'rebb', 'rebc']);
      const before = await Promise.all(
        players.map((player) => leaderboard.getRank('today', player.userId)),
      );

      await ctx.redis.flushdb();

      expect(await ctx.redis.zcard(dailyKey(todayUtc()))).toBe(0);

      const rebuilt = await leaderboard.rebuild('today');
      expect(rebuilt).toBe(3);
      await leaderboard.rebuild('week');

      const after = await Promise.all(
        players.map((player) => leaderboard.getRank('today', player.userId)),
      );
      expect(after).toEqual(before);

      const fromPostgres = await leaderboard.ranksFromPostgres(todayUtc());
      for (const row of fromPostgres) {
        expect(await leaderboard.getRank('today', row.userId)).toBe(row.rank);
      }

      expect(await ctx.redis.zcard(weekKey())).toBe(3);
    });

    /**
     * A read after a flush must not simply report an empty board — the player
     * would see their score vanish. `resolveKey` rebuilds a missing key
     * lazily, so the next request repairs it.
     */
    it('repairs a missing key on the next read', async () => {
      const players = await playField(['lazya', 'lazyb']);

      await ctx.redis.flushdb();

      const response = await players[0].api.get('/v1/leaderboard?scope=today');

      expect(response.status).toBe(200);
      expect(response.body.totalPlayers).toBe(2);
      expect(response.body.me.rank).not.toBeNull();
    });

    it('marks an empty board ready and collapses concurrent rebuilds', async () => {
      const lurker = await registerPlayer(api, 'lb-empty-board', 'emptyboard');
      await ctx.redis.flushdb();
      const repository = (leaderboard as any).dailyScores;
      const querySpy = jest.spyOn(repository, 'createQueryBuilder');

      const ranks = await Promise.all(
        Array.from({ length: 12 }, () =>
          leaderboard.getRank('today', lurker.userId),
        ),
      );

      expect(ranks).toEqual(Array(12).fill(null));
      expect(querySpy).toHaveBeenCalledTimes(1);
      expect(await ctx.redis.exists(boardReadyKey(dailyKey(todayUtc())))).toBe(
        1,
      );
      querySpy.mockRestore();
    });

    it('surfaces command-level Redis transaction errors', async () => {
      await playField(['wrongtype']);
      const key = dailyKey(todayUtc());
      await ctx.redis.set(key, 'not-a-sorted-set');

      await expect(leaderboard.rebuild('today')).rejects.toThrow('WRONGTYPE');

      await ctx.redis.del(key);
      await leaderboard.rebuild('today');
    });
  });

  describe('the nightly rank snapshot', () => {
    it('compares today’s live rank with yesterday’s final rank', async () => {
      const [chaser, leader] = await playField(['snapa', 'snapb']);
      const today = todayUtc();
      const yesterday = addDays(today, -1);

      await leaderboard.persistDailyScore(chaser.userId, yesterday, 100);
      await leaderboard.persistDailyScore(leader.userId, yesterday, 200);
      expect(await leaderboard.snapshotRanks(yesterday)).toBe(2);

      // Chaser moves from yesterday's rank 2 to today's live rank 1.
      await setScore(ctx, chaser.userId, today, 300);
      await setScore(ctx, leader.userId, today, 200);
      await leaderboard.rebuild('today');

      const rows = await ctx.dataSource.query(
        'SELECT "userId", "rank" FROM daily_score WHERE "challengeDate" = $1 ORDER BY "rank"',
        [yesterday],
      );
      expect(rows.map((row: any) => Number(row.rank))).toEqual([1, 2]);
      expect(Number(rows[0].userId)).toBe(leader.userId);

      const board = await chaser.api.get('/v1/leaderboard?scope=today');
      expect(board.body.me.rank).toBe(1);
      // Rank 2 → rank 1 is "▲ 1".
      expect(board.body.me.delta).toBe(1);
    });
  });
});
