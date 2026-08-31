import { ConfigService } from '@nestjs/config';

import { addDays, todayUtc } from '../src/common/utils/date.util';
import { AppConfig } from '../src/config/configuration';
import { dailyKey } from '../src/modules/leaderboard/leaderboard.keys';
import {
  ROUND_NOT_SERVED,
  ROUND_TOO_FAST,
} from '../src/modules/sessions/round-problems';
import { Api } from './support/api-client';
import { playRound, registerPlayer } from './support/players';
import { createTestApp, resetGameplayState, TestApp } from './support/test-app';

/**
 * Phase 4 exit criteria: a replayed bet is idempotent, and a daily session
 * cannot be started twice. Both are enforced in the database rather than in
 * application logic — a composite primary key and a partial unique index — so
 * these cases deliberately drive real concurrent requests at them.
 */
describe('the game loop', () => {
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

  /**
   * A legal bet on a session's first round, without dealing it.
   *
   * Two cases here have to place a bet *before* calling `/current`, which is
   * the only way to sit outside the shot clock — so the bounds cannot be read
   * off the response. They are pinned on the session when it is created, which
   * lets this read the exact contract without re-running secret-keyed logic.
   *
   * Worth being exact rather than approximate. An arbitrary bet used to pass
   * only because it happened to land inside the fixture's slider, and when that
   * stopped being true the bounds check answered first and the assertion about
   * the clock quietly became an assertion about nothing.
   */
  async function legalBetFor(
    sessionId: string,
  ): Promise<{ loCents: number; hiCents: number }> {
    const [row] = await ctx.dataSource.query(
      `SELECT "sliderMinCents", "sliderMaxCents"
       FROM game_session WHERE id = $1`,
      [sessionId],
    );

    return {
      loCents: Number(row.sliderMinCents[0]),
      hiCents: Number(row.sliderMaxCents[0]),
    };
  }

  describe('starting a session', () => {
    it('resumes rather than restarts today’s daily', async () => {
      const player = await registerPlayer(api, 'loop-device-0001', 'resumer');

      const first = await player.api.post('/v1/sessions', { mode: 'daily' });
      expect(first.status).toBe(201);
      expect(first.body.resumed).toBe(false);
      expect(first.body.roundCount).toBe(5);
      expect(first.body.currentIndex).toBe(0);

      await playRound(player.api, first.body.id, 0);

      const second = await player.api.post('/v1/sessions', { mode: 'daily' });
      expect(second.body.id).toBe(first.body.id);
      expect(second.body.resumed).toBe(true);
      // Resuming returns progress, which is what the "Continue" card renders.
      expect(second.body.currentIndex).toBe(1);
    });

    /**
     * The double-tap on "Play". Both requests reach the insert before either
     * commits, so the partial unique index — not a prior read — is what stops
     * the second session existing.
     */
    it('survives two concurrent creates with a single row', async () => {
      const player = await registerPlayer(api, 'loop-device-0002', 'doubletap');

      const results = await Promise.all([
        player.api.post('/v1/sessions', { mode: 'daily' }),
        player.api.post('/v1/sessions', { mode: 'daily' }),
        player.api.post('/v1/sessions', { mode: 'daily' }),
      ]);

      for (const result of results) expect(result.status).toBe(201);

      const ids = new Set(results.map((r) => r.body.id));
      expect(ids.size).toBe(1);

      const rows = await ctx.dataSource.query(
        `SELECT COUNT(*)::int AS count FROM game_session
         WHERE "userId" = $1 AND mode = 'daily'`,
        [player.userId],
      );
      expect(rows[0].count).toBe(1);
    });

    it('requires a theme for a quick round', async () => {
      const player = await registerPlayer(api, 'loop-device-0003');

      const response = await player.api.post('/v1/sessions', { mode: 'quick' });

      expect(response.status).toBe(400);
    });

    it('pins slider geometry and scoring rules when the session starts', async () => {
      const player = await registerPlayer(api, 'loop-device-pinned-config');
      const response = await player.api.post('/v1/sessions', {
        mode: 'quick',
        themeSlug: 'everyday-stuff',
      });

      const [row] = await ctx.dataSource.query(
        `SELECT cardinality("sliderMinCents")::int AS mins,
                cardinality("sliderMaxCents")::int AS maxes,
                "scoringVersion"
         FROM game_session WHERE id = $1`,
        [response.body.id],
      );

      expect(row).toEqual({ mins: 5, maxes: 5, scoringVersion: 'v2' });
    });

    it('leaves exactly one active quick session after concurrent starts', async () => {
      const player = await registerPlayer(api, 'loop-device-quick-concurrent');

      const results = await Promise.all([
        player.api.post('/v1/sessions', {
          mode: 'quick',
          themeSlug: 'everyday-stuff',
        }),
        player.api.post('/v1/sessions', {
          mode: 'quick',
          themeSlug: 'everyday-stuff',
        }),
        player.api.post('/v1/sessions', {
          mode: 'quick',
          themeSlug: 'everyday-stuff',
        }),
      ]);

      for (const result of results) expect(result.status).toBe(201);

      const [counts] = await ctx.dataSource.query<
        Array<{ active: number; abandoned: number }>
      >(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'active')::int AS active,
           COUNT(*) FILTER (WHERE status = 'abandoned')::int AS abandoned
         FROM game_session
         WHERE "userId" = $1 AND mode = 'quick'`,
        [player.userId],
      );
      expect(counts).toEqual({ active: 1, abandoned: 2 });
    });

    it('rejects an unknown mode with a validation error', async () => {
      const player = await registerPlayer(api, 'loop-device-0004');

      const response = await player.api.post('/v1/sessions', { mode: 'nope' });

      expect(response.status).toBe(400);
      expect(response.body.errors).toEqual(expect.any(Array));
    });
  });

  describe('placing a bet', () => {
    it('scores the round, advances the session and closes it on the last one', async () => {
      const player = await registerPlayer(api, 'loop-device-0005', 'scorer');
      const session = await player.api.post('/v1/sessions', { mode: 'daily' });
      const sessionId = session.body.id as string;

      let running = 0;
      for (let index = 0; index < 5; index++) {
        const { current, reveal } = await playRound(
          player.api,
          sessionId,
          index,
        );

        expect(current.roundIndex).toBe(index);
        expect(reveal.round.roundIndex).toBe(index);
        expect(reveal.round.truePriceCents).toBeGreaterThan(0);
        expect(reveal.replayed).toBe(false);

        // A miss scores nothing at all — README is authoritative over the
        // prototype summary screen, which shows points on missed rows.
        if (!reveal.round.hit) expect(reveal.round.points).toBe(0);
        // The multiplier is reported either way: the player saw it before
        // committing, and hiding it afterwards would look like a bug.
        expect(reveal.round.multiplier).toBeGreaterThan(0);

        running += reveal.round.points;
        expect(reveal.totalScore).toBe(running);

        const last = index === 4;
        expect(reveal.isSessionComplete).toBe(last);
        expect(reveal.nextRoundIndex).toBe(last ? null : index + 1);
      }

      const [dailyScore] = await ctx.dataSource.query(
        `SELECT score FROM daily_score
         WHERE "userId" = $1 AND "challengeDate" = $2`,
        [player.userId, todayUtc()],
      );
      expect(Number(dailyScore.score)).toBe(running);
    });

    it('returns the stored result when the same bet is replayed', async () => {
      const player = await registerPlayer(api, 'loop-device-0006', 'replayer');
      const session = await player.api.post('/v1/sessions', { mode: 'daily' });
      const sessionId = session.body.id as string;

      const { reveal } = await playRound(player.api, sessionId, 0);

      // A different range on purpose: a replay must return what was recorded,
      // not rescore against whatever arrived second.
      const replay = await player.api.post(
        `/v1/sessions/${sessionId}/rounds/0/bet`,
        { loCents: reveal.sliderMinCents, hiCents: reveal.sliderMaxCents },
      );

      expect(replay.status).toBe(200);
      expect(replay.body.replayed).toBe(true);
      expect(replay.body.round.loCents).toBe(reveal.round.loCents);
      expect(replay.body.round.hiCents).toBe(reveal.round.hiCents);
      expect(replay.body.round.points).toBe(reveal.round.points);
      expect(replay.body.totalScore).toBe(reveal.totalScore);
    });

    /**
     * The retry a flaky mobile connection actually produces: the same bet sent
     * twice, in flight simultaneously. One insert wins the composite primary
     * key; the loser must read the winner's row rather than error.
     */
    it('records a score once when the same bet arrives twice at once', async () => {
      const player = await registerPlayer(api, 'loop-device-0007', 'racer');
      const session = await player.api.post('/v1/sessions', { mode: 'daily' });
      const sessionId = session.body.id as string;

      const current = await player.api.get(`/v1/sessions/${sessionId}/current`);
      const bet = {
        loCents: current.body.suggestedLoCents,
        hiCents: current.body.suggestedHiCents,
      };

      const [a, b] = await Promise.all([
        player.api.post(`/v1/sessions/${sessionId}/rounds/0/bet`, bet),
        player.api.post(`/v1/sessions/${sessionId}/rounds/0/bet`, bet),
      ]);

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.round.points).toBe(b.body.round.points);
      expect(a.body.totalScore).toBe(b.body.totalScore);

      const rounds = await ctx.dataSource.query(
        'SELECT COUNT(*)::int AS count FROM session_round WHERE "sessionId" = $1',
        [sessionId],
      );
      expect(rounds[0].count).toBe(1);

      // And the player's totals were credited once, not twice.
      const user = await ctx.dataSource.query(
        'SELECT "totalPoints" FROM "user" WHERE id = $1',
        [player.userId],
      );
      expect(Number(user[0].totalPoints)).toBe(a.body.round.points);
    });

    it('refuses a round played out of order', async () => {
      const player = await registerPlayer(api, 'loop-device-0008');
      const session = await player.api.post('/v1/sessions', { mode: 'daily' });
      const current = await player.api.get(
        `/v1/sessions/${session.body.id}/current`,
      );

      const response = await player.api.post(
        `/v1/sessions/${session.body.id}/rounds/3/bet`,
        {
          loCents: current.body.suggestedLoCents,
          hiCents: current.body.suggestedHiCents,
        },
      );

      expect(response.status).toBe(409);
    });

    it('refuses a round index the session does not have', async () => {
      const player = await registerPlayer(api, 'loop-device-0009');
      const session = await player.api.post('/v1/sessions', { mode: 'daily' });

      const response = await player.api.post(
        `/v1/sessions/${session.body.id}/rounds/99/bet`,
        { loCents: 1000, hiCents: 2000 },
      );

      expect(response.status).toBe(400);
    });

    it('refuses a bet outside the slider or off the increment', async () => {
      const player = await registerPlayer(api, 'loop-device-0010');
      const session = await player.api.post('/v1/sessions', { mode: 'daily' });
      const sessionId = session.body.id as string;
      const current = await player.api.get(`/v1/sessions/${sessionId}/current`);

      const outside = await player.api.post(
        `/v1/sessions/${sessionId}/rounds/0/bet`,
        {
          loCents: current.body.sliderMinCents,
          hiCents: current.body.sliderMaxCents + current.body.incrementCents,
        },
      );
      expect(outside.status).toBe(400);

      const offStep = await player.api.post(
        `/v1/sessions/${sessionId}/rounds/0/bet`,
        {
          loCents: current.body.suggestedLoCents + 1,
          hiCents: current.body.suggestedHiCents,
        },
      );
      expect(offStep.status).toBe(400);
    });

    it('enforces time-on-round without letting reloads reset the timer', async () => {
      const config = ctx.app.get(ConfigService).getOrThrow<AppConfig>('app');
      const originalMinimum = config.minRoundSeconds;
      const originalLimit = config.roundSeconds;
      // The floor is the point here, so the deadline is moved out of its way:
      // at the shipped ten seconds the bet below would land as a timeout and
      // prove nothing about the minimum.
      config.minRoundSeconds = 60;
      config.roundSeconds = 120;

      try {
        const player = await registerPlayer(
          api,
          'loop-device-timing',
          'deliberate',
        );
        const session = await player.api.post('/v1/sessions', {
          mode: 'quick',
          themeSlug: 'vintage-finds',
        });
        const bet = await legalBetFor(session.body.id);
        const path = `/v1/sessions/${session.body.id}/rounds/0/bet`;

        const notServed = await player.api.post(path, bet);
        expect(notServed.status).toBe(400);
        expect(notServed.body.title).toContain('Load the round');
        // `type` is the half the app reads: it picks its own sentence, in its
        // own language, from the slug. Asserted here so rewording the title
        // above stays free and renaming the slug does not.
        expect(notServed.body.type).toBe(ROUND_NOT_SERVED);

        expect(
          (await player.api.get(`/v1/sessions/${session.body.id}/current`))
            .status,
        ).toBe(200);
        const tooFast = await player.api.post(path, bet);
        expect(tooFast.status).toBe(400);
        expect(tooFast.body.title).toContain('Take a moment');
        expect(tooFast.body.type).toBe(ROUND_TOO_FAST);

        await ctx.dataSource.query(
          `UPDATE game_session
           SET "currentServedAt" = NOW() - INTERVAL '61 seconds'
           WHERE id = $1`,
          [session.body.id],
        );
        await player.api.get(`/v1/sessions/${session.body.id}/current`);

        const accepted = await player.api.post(path, bet);
        expect(accepted.status).toBe(200);

        const [advanced] = await ctx.dataSource.query(
          `SELECT "currentIndex", "currentServedAt"
           FROM game_session WHERE id = $1`,
          [session.body.id],
        );
        expect(advanced.currentIndex).toBe(1);
        expect(advanced.currentServedAt).toBeNull();
      } finally {
        config.minRoundSeconds = originalMinimum;
        config.roundSeconds = originalLimit;
      }
    });

    it('will not let one player bet on another player’s session', async () => {
      const owner = await registerPlayer(api, 'loop-device-0011', 'owner');
      const stranger = await registerPlayer(
        api,
        'loop-device-0012',
        'stranger',
      );

      const session = await owner.api.post('/v1/sessions', { mode: 'daily' });

      const peek = await stranger.api.get(
        `/v1/sessions/${session.body.id}/current`,
      );
      // Not a 404: the id is real, the caller simply does not own it.
      expect(peek.status).toBe(403);

      const bet = await stranger.api.post(
        `/v1/sessions/${session.body.id}/rounds/0/bet`,
        { loCents: 1000, hiCents: 2000 },
      );
      expect(bet.status).toBe(403);

      const summary = await stranger.api.get(
        `/v1/sessions/${session.body.id}/summary`,
      );
      expect(summary.status).toBe(403);
    });
  });

  /**
   * The shot clock is server-side and nothing else: the client is never asked
   * what time it is, and every case below moves `currentServedAt` in the
   * database rather than sleeping, because that is the only input the deadline
   * is computed from.
   */
  describe('the shot clock', () => {
    /** Ages the round on the server, as if the player had sat on it. */
    const ageRound = (sessionId: string, seconds: number) =>
      ctx.dataSource.query(
        `UPDATE game_session
         SET "currentServedAt" = NOW() - make_interval(secs => $2)
         WHERE id = $1`,
        [sessionId, seconds],
      );

    const startQuick = async (deviceId: string, username: string) => {
      const player = await registerPlayer(api, deviceId, username);
      const session = await player.api.post('/v1/sessions', {
        mode: 'quick',
        themeSlug: 'vintage-finds',
      });
      return { player, sessionId: session.body.id as string };
    };

    it('deals the round with the time left on it', async () => {
      const config = ctx.app.get(ConfigService).getOrThrow<AppConfig>('app');
      const { player, sessionId } = await startQuick(
        'loop-device-clock1',
        'ticker',
      );

      const dealt = await player.api.get(`/v1/sessions/${sessionId}/current`);
      expect(dealt.status).toBe(200);
      expect(dealt.body.roundSeconds).toBe(config.roundSeconds);
      expect(dealt.body.remainingMs).toBeGreaterThan(0);
      expect(dealt.body.remainingMs).toBeLessThanOrEqual(
        config.roundSeconds * 1000,
      );
      expect(Date.parse(dealt.body.expiresAt)).toBeGreaterThan(Date.now());
    });

    /**
     * The cheat this exists to close: deal a round, take as long as you like,
     * then re-fetch it for a fresh ten seconds. The deadline is stamped once.
     */
    it('does not hand back a fresh deadline when the round is re-fetched', async () => {
      const { player, sessionId } = await startQuick(
        'loop-device-clock2',
        'refetcher',
      );

      await player.api.get(`/v1/sessions/${sessionId}/current`);
      await ageRound(sessionId, 6);

      const again = await player.api.get(`/v1/sessions/${sessionId}/current`);
      expect(again.status).toBe(200);
      // `ageRound` writes Postgres' `NOW()` while `remainingMs` is measured
      // against Node's clock, and the container's runs tens of milliseconds
      // ahead of the host's — so six seconds of ageing reads back as slightly
      // less. The slack absorbs that skew without weakening what is being
      // asserted: a refreshed deadline would hand back the full 10,000.
      expect(again.body.remainingMs).toBeLessThanOrEqual(4_500);
    });

    it('scores nothing for a bet that arrives after the deadline', async () => {
      const { player, sessionId } = await startQuick(
        'loop-device-clock3',
        'dawdler',
      );

      const dealt = await player.api.get(`/v1/sessions/${sessionId}/current`);
      await ageRound(sessionId, 60);

      // Deliberately the server's own suggested range, which is legal in every
      // other respect: the round is lost to the clock, not to the bet.
      const reveal = await player.api.post(
        `/v1/sessions/${sessionId}/rounds/0/bet`,
        {
          loCents: dealt.body.suggestedLoCents,
          hiCents: dealt.body.suggestedHiCents,
        },
      );

      // Recorded rather than refused. A 400 would strand the player on a round
      // they can never place a legal bet on again.
      expect(reveal.status).toBe(200);
      expect(reveal.body.round.timedOut).toBe(true);
      expect(reveal.body.round.hit).toBe(false);
      expect(reveal.body.round.points).toBe(0);
      expect(reveal.body.totalScore).toBe(0);
      expect(reveal.body.round.elapsedMs).toBeGreaterThan(59 * 1000);
      // And the session moves on, which is the whole point of recording it.
      expect(reveal.body.nextRoundIndex).toBe(1);
    });

    it('still accepts a bet placed on the last tick, allowing for its flight', async () => {
      const config = ctx.app.get(ConfigService).getOrThrow<AppConfig>('app');
      const { player, sessionId } = await startQuick(
        'loop-device-clock4',
        'buzzerbeater',
      );

      const dealt = await player.api.get(`/v1/sessions/${sessionId}/current`);
      // Past the deadline, but inside the grace that covers the request's own
      // travel — a player who tapped at zero must not lose the round to their
      // own latency.
      await ageRound(
        sessionId,
        config.roundSeconds + config.roundGraceMs / 2000,
      );

      const reveal = await player.api.post(
        `/v1/sessions/${sessionId}/rounds/0/bet`,
        {
          loCents: dealt.body.suggestedLoCents,
          hiCents: dealt.body.suggestedHiCents,
        },
      );
      expect(reveal.status).toBe(200);
      expect(reveal.body.round.timedOut).toBe(false);
    });

    it('records the timeout on the summary too, not only on the reveal', async () => {
      const { player, sessionId } = await startQuick(
        'loop-device-clock5',
        'summarised',
      );

      const dealt = await player.api.get(`/v1/sessions/${sessionId}/current`);
      await ageRound(sessionId, 60);
      await player.api.post(`/v1/sessions/${sessionId}/rounds/0/bet`, {
        loCents: dealt.body.suggestedLoCents,
        hiCents: dealt.body.suggestedHiCents,
      });

      const summary = await player.api.get(`/v1/sessions/${sessionId}/summary`);
      expect(summary.status).toBe(200);
      expect(summary.body.rounds[0].timedOut).toBe(true);
      expect(summary.body.hits).toBe(0);
    });

    it('refuses a bet on a round the server never dealt', async () => {
      const { player, sessionId } = await startQuick(
        'loop-device-clock6',
        'unclocked',
      );

      // No GET /current, so there is no stamp and therefore no deadline to
      // measure against — the one way to sit outside the clock entirely. The
      // bet itself has to be legal, or the bounds check answers first and this
      // proves nothing about the clock.
      const blind = await player.api.post(
        `/v1/sessions/${sessionId}/rounds/0/bet`,
        await legalBetFor(sessionId),
      );
      expect(blind.status).toBe(400);
      expect(blind.body.title).toContain('Load the round');
    });

    it('leaves the round unclocked when the limit is off', async () => {
      const config = ctx.app.get(ConfigService).getOrThrow<AppConfig>('app');
      const originalLimit = config.roundSeconds;
      config.roundSeconds = 0;

      try {
        const { player, sessionId } = await startQuick(
          'loop-device-clock7',
          'untimed',
        );

        const dealt = await player.api.get(`/v1/sessions/${sessionId}/current`);
        expect(dealt.body.roundSeconds).toBe(0);
        expect(dealt.body.remainingMs).toBeNull();
        expect(dealt.body.expiresAt).toBeNull();

        await ageRound(sessionId, 3_600);
        const reveal = await player.api.post(
          `/v1/sessions/${sessionId}/rounds/0/bet`,
          {
            loCents: dealt.body.suggestedLoCents,
            hiCents: dealt.body.suggestedHiCents,
          },
        );
        expect(reveal.status).toBe(200);
        expect(reveal.body.round.timedOut).toBe(false);
      } finally {
        config.roundSeconds = originalLimit;
      }
    });
  });

  describe('the summary screen', () => {
    it('reports hits, average error, share text and a percentile', async () => {
      const player = await registerPlayer(
        api,
        'loop-device-0013',
        'summariser',
      );
      const session = await player.api.post('/v1/sessions', { mode: 'daily' });
      const sessionId = session.body.id as string;

      for (let index = 0; index < 5; index++) {
        await playRound(player.api, sessionId, index);
      }

      const summary = await player.api.get(`/v1/sessions/${sessionId}/summary`);

      expect(summary.status).toBe(200);
      expect(summary.body.rounds).toHaveLength(5);
      expect(summary.body.roundCount).toBe(5);
      expect(summary.body.status).toBe('complete');
      expect(summary.body.hits).toBe(
        summary.body.rounds.filter((round: any) => round.hit).length,
      );
      expect(summary.body.avgErrorPct).toBeGreaterThanOrEqual(0);
      expect(summary.body.totalScore).toBe(
        summary.body.rounds.reduce(
          (sum: number, round: any) => sum + round.points,
          0,
        ),
      );

      // Wordle-style: shape of the game, never the answers.
      expect(summary.body.shareText).toContain('CashOrTrash');
      expect(summary.body.shareText).toMatch(/[🟩⬜]{5}/u);

      // A completed daily has a standing to compare against; the player is
      // alone on the board, so they beat nobody but themselves.
      expect(typeof summary.body.percentile).toBe('number');
    });

    it('updates the player’s profile totals and streak', async () => {
      const player = await registerPlayer(api, 'loop-device-0014', 'streaker');
      const session = await player.api.post('/v1/sessions', { mode: 'daily' });

      const rounds = [];
      for (let index = 0; index < 5; index++) {
        rounds.push(await playRound(player.api, session.body.id, index));
      }

      const me = await player.api.get('/v1/me');

      const total = rounds.reduce((sum, r) => sum + r.reveal.round.points, 0);
      const best = Math.max(...rounds.map((r) => r.reveal.round.points));

      expect(me.status).toBe(200);
      expect(me.body.totalPoints).toBe(total);
      // The best *single* round — the app calls one item a round.
      expect(me.body.bestRoundScore).toBe(best);
      expect(me.body.streakDays).toBe(1);
    });

    it('uses the session date when reopening an older daily summary', async () => {
      const target = await registerPlayer(
        api,
        'loop-device-history-target',
        'historytarget',
      );
      const peer = await registerPlayer(
        api,
        'loop-device-history-peer',
        'historypeer',
      );
      const targetSession = await target.api.post('/v1/sessions', {
        mode: 'daily',
      });
      const peerSession = await peer.api.post('/v1/sessions', {
        mode: 'daily',
      });

      for (let index = 0; index < 5; index++) {
        await playRound(target.api, targetSession.body.id, index);
        await playRound(peer.api, peerSession.body.id, index);
      }

      const today = todayUtc();
      const yesterday = addDays(today, -1);
      await ctx.dataSource.query(
        `UPDATE daily_score
         SET "challengeDate" = $1,
             score = CASE WHEN "userId" = $2 THEN 100 ELSE 200 END
         WHERE "userId" IN ($2, $3) AND "challengeDate" = $4`,
        [yesterday, target.userId, peer.userId, today],
      );
      await ctx.dataSource.query(
        `UPDATE game_session SET "dailyDate" = $1 WHERE id IN ($2, $3)`,
        [yesterday, targetSession.body.id, peerSession.body.id],
      );
      await ctx.redis.del(dailyKey(today));

      const summary = await target.api.get(
        `/v1/sessions/${targetSession.body.id}/summary`,
      );

      expect(summary.status).toBe(200);
      expect(summary.body.percentile).toBe(0);
    });
  });

  /**
   * The mystery mix advertises "+10% point bonus" on its picker card, and the
   * only place that promise can be kept is the score. Every layer between the
   * two is easy to get right in isolation and still not add up: the theme row
   * carries `bonusPct`, `createQuick` stores the theme id, and `placeBet` looks
   * the bonus back up — but a session that dropped its theme id, or a mystery
   * row seeded before the bonus existed, pays nothing and says nothing.
   *
   * So this asserts the arithmetic rather than the plumbing: points have to be
   * base x multiplier x 1.1, not base x multiplier.
   */
  describe('the mystery mix bonus', () => {
    it('pays the advertised bonus on a scored round', async () => {
      const player = await registerPlayer(api, 'mystery-device-0001');

      const themes = await player.api.get('/v1/themes');
      const mystery = themes.body.find((theme: any) => theme.isMystery);
      expect(mystery.bonusPct).toBeGreaterThan(0);

      const session = await player.api.post('/v1/sessions', {
        mode: 'quick',
        themeSlug: mystery.slug,
      });
      expect(session.status).toBe(201);

      const current = await player.api.get(
        `/v1/sessions/${session.body.id}/current`,
      );
      expect(current.status).toBe(200);

      const [item] = await ctx.dataSource.query(
        'SELECT "truePriceCents" FROM item WHERE id = $1',
        [current.body.itemId],
      );
      const price = Number(item.truePriceCents);

      // A bet that hits, centred on the answer, so base points are non-zero and
      // the bonus has something to act on. Snapped to the increment from the
      // floor, which is what `validateBet` measures against.
      const {
        sliderMinCents: min,
        sliderMaxCents: max,
        incrementCents,
      } = current.body;
      const snap = (value: number) =>
        Math.min(
          max,
          Math.max(
            min,
            min + Math.round((value - min) / incrementCents) * incrementCents,
          ),
        );
      const reach = incrementCents * 2;
      const bet = {
        loCents: snap(price - reach),
        hiCents: snap(price + reach),
      };

      const reveal = await player.api.post(
        `/v1/sessions/${session.body.id}/rounds/0/bet`,
        bet,
      );

      expect(reveal.status).toBe(200);
      expect(reveal.body.round.hit).toBe(true);
      expect(reveal.body.round.basePoints).toBeGreaterThan(0);

      const { basePoints, multiplier, points } = reveal.body.round;
      expect(points).toBe(
        Math.round(basePoints * multiplier * (1 + mystery.bonusPct)),
      );
      expect(points).toBeGreaterThan(Math.round(basePoints * multiplier));
    });
  });
});
