import { ConfigService } from '@nestjs/config';

import { addDays, todayUtc } from '../../src/common/utils/date.util';
import { AppConfig } from '../../src/config/configuration';
import { CatalogService } from '../../src/modules/catalog/catalog.service';
import { DailyService } from '../../src/modules/daily/daily.service';
import { Api } from '../support/api-client';
import { playRound, registerPlayer } from '../support/players';
import {
  createTestApp,
  resetGameplayState,
  TestApp,
} from '../support/test-app';

/**
 * The reveal at the end of a round hands the player the true price. That makes
 * quick and head-to-head rounds a way of *learning* prices and the daily a way
 * of being *tested* on them — and drawing all three from one unrestricted pool
 * means the first can answer the second, either by accident over a long enough
 * play history or on purpose in an afternoon of scripted sessions.
 *
 * Two rules follow, and this suite is both of them:
 *
 *  1. an item a daily still has to ask about is never dealt anywhere else;
 *  2. an item this player has already been dealt does not come straight back.
 *
 * A third follows from the first, and is easy to miss: the days are subtracted
 * from each other too. Two challenges drawn independently from one catalogue
 * collide readily, and a collision means sitting Tuesday's challenge answers a
 * round of Friday's.
 *
 * None may be enforced by refusing to deal a round — the catalogue is finite
 * and a player who has seen all of it must still be able to press Play — so the
 * middle section here is about bending rather than breaking. And the whole
 * thing is bounded by one guarantee it must not cost: the daily is never
 * filtered by *who is asking*, because "the same five items for everyone" is
 * what makes the leaderboard a comparison rather than a list. Holding back what
 * another date already claimed is compatible with that and is rule 3; holding
 * back what a player has seen is not, and is the line this suite defends.
 *
 * Cases that need an exact answer call `CatalogService` directly. Quick rounds
 * seed their draw from a fresh UUID on purpose — they are the one mode nobody
 * is compared on — so through the API only the *tiering* is deterministic, not
 * the shuffle inside a tier.
 */
describe('draw pool exclusions', () => {
  let ctx: TestApp;
  let api: Api;
  let catalog: CatalogService;
  let daily: DailyService;
  let config: AppConfig;

  beforeAll(async () => {
    ctx = await createTestApp();
    api = ctx.api;
    catalog = ctx.app.get(CatalogService);
    daily = ctx.app.get(DailyService);
    config = ctx.app.get(ConfigService).getOrThrow<AppConfig>('app');
  });

  beforeEach(async () => {
    await resetGameplayState(ctx);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const itemsOf = async (sessionId: string): Promise<number[]> => {
    const [row] = await ctx.dataSource.query(
      'SELECT "itemIds" FROM game_session WHERE id = $1',
      [sessionId],
    );
    return (row.itemIds as unknown[]).map(Number);
  };

  const dailyItems = async (): Promise<number[]> => {
    const [row] = await ctx.dataSource.query(
      'SELECT "itemIds" FROM daily_challenge ORDER BY "challengeDate" ASC LIMIT 1',
    );
    return (row.itemIds as unknown[]).map(Number);
  };

  const themeIdFor = async (slug: string): Promise<number> => {
    const [row] = await ctx.dataSource.query(
      'SELECT id FROM theme WHERE slug = $1',
      [slug],
    );
    return Number(row.id);
  };

  /**
   * Always the mystery mix unless a case says otherwise. A themed pool is six
   * items and today's daily reserves five of the twenty-four, so a themed draw
   * can legitimately fall through to reserved items — asserting rule 1 there
   * would be asserting the fallback instead.
   */
  const startQuick = async (
    player: { api: Api },
    themeSlug = 'mystery-mix',
  ): Promise<string> => {
    const session = await player.api.post('/v1/sessions', {
      mode: 'quick',
      themeSlug,
    });
    expect(session.status).toBe(201);
    return session.body.id as string;
  };

  /**
   * A quick round played to the end, which is what spends its five items — an
   * item is charged to a player when it is shown, and a session nobody opened
   * has shown nothing. Returns what was dealt.
   */
  const playThrough = async (
    player: { api: Api },
    themeSlug = 'mystery-mix',
  ): Promise<number[]> => {
    const sessionId = await startQuick(player, themeSlug);
    for (let index = 0; index < config.roundsPerSession; index++) {
      await playRound(player.api, sessionId, index);
    }
    return itemsOf(sessionId);
  };

  /**
   * A played-out session, written straight to the table.
   *
   * `currentIndex` is the point of it: the seen window is the prefix of a
   * session the player actually reached, so a row left at the default zero is
   * a session that showed nobody anything and spends no cooldown. Cases that
   * need an exact draw insert history rather than playing it, and they have to
   * say that it was played.
   */
  const recordPlayed = (
    userId: number,
    themeId: number,
    itemIds: number[],
  ): Promise<unknown> =>
    ctx.dataSource.query(
      `INSERT INTO game_session
         (id, "userId", mode, "themeId", "itemIds", "currentIndex", status, "completedAt")
       VALUES (gen_random_uuid(), $1, 'quick', $2, $3::int[],
               cardinality($3::int[]), 'complete', now())`,
      [userId, themeId, itemIds],
    );

  describe('the daily pool is reserved', () => {
    it('never deals a quick round an item the daily still has to ask about', async () => {
      const player = await registerPlayer(api, 'pool-device-0001', 'reserver');

      // Materialises today's challenge, which is what marks its five reserved.
      await player.api.post('/v1/sessions', { mode: 'daily' });
      const reserved = await dailyItems();
      expect(reserved).toHaveLength(5);

      const drawn = await itemsOf(await startQuick(player));

      expect(drawn.filter((id) => reserved.includes(id))).toEqual([]);
    });

    it('reserves it against a head-to-head too', async () => {
      const player = await registerPlayer(api, 'pool-device-0002', 'h2hres');
      await player.api.post('/v1/sessions', { mode: 'daily' });
      const reserved = await dailyItems();

      const match = await player.api.post('/v1/matches', {
        themeSlug: 'mystery-mix',
      });
      expect(match.status).toBe(201);

      const [row] = await ctx.dataSource.query(
        'SELECT "itemIds" FROM match WHERE id = $1',
        [match.body.id],
      );
      const drawn = (row.itemIds as unknown[]).map(Number);

      expect(drawn.filter((id) => reserved.includes(id))).toEqual([]);
    });
  });

  describe('an item does not come straight back to the same player', () => {
    it('deals two consecutive played rounds from disjoint sets', async () => {
      const player = await registerPlayer(api, 'pool-device-0003', 'cooled');

      const first = await playThrough(player);
      const second = await itemsOf(await startQuick(player));

      expect(second.filter((id) => first.includes(id))).toEqual([]);
    });

    /**
     * An item is spent when it is *shown*, not when it is bet on. Otherwise the
     * cheapest way to map the catalogue would be to start sessions and read
     * `/current` without ever finishing them, and the exclusion would never
     * charge for a single one.
     */
    it('spends an item on being shown, with no bet placed at all', async () => {
      const player = await registerPlayer(api, 'pool-device-0004', 'peeker');

      const first = await startQuick(player);
      const current = await player.api.get(`/v1/sessions/${first}/current`);
      expect(current.status).toBe(200);

      const second = await itemsOf(await startQuick(player));

      expect(second).not.toContain(Number(current.body.itemId));
    });

    /**
     * And *only* when it is shown. Starting a quick round retires the previous
     * one, so a player who reaches the picker, changes their mind and picks
     * again used to spend five items of a thirty-day cooldown on four rounds
     * they were never dealt — draining their own pool four times faster than
     * they played, until every draw came back as a repeat.
     */
    it('does not spend the rounds a retired session never reached', async () => {
      const player = await registerPlayer(api, 'pool-device-0014', 'browser');
      const themeId = await themeIdFor('everyday-stuff');
      const seed = 'fixed-seed-for-the-unshown-case';

      // The six-item theme, so the answer is exact: with five of the six spent
      // the draw is forced, and with none spent it is the plain shuffle.
      const dealt = await catalog.drawItemIds(themeId, 5, seed);
      const [{ id: sessionId }] = await ctx.dataSource.query(
        `INSERT INTO game_session (id, "userId", mode, "themeId", "itemIds")
         VALUES (gen_random_uuid(), $1, 'quick', $2, $3::int[]) RETURNING id`,
        [player.userId, themeId, dealt],
      );

      // Dealt but never fetched: no round was shown, so nothing is spent and
      // the draw is indistinguishable from one for a player with no history.
      expect(
        await catalog.drawItemIds(themeId, 5, seed, {
          excludeSeenBy: player.userId,
        }),
      ).toEqual(dealt);

      // Played through, and now every one of them is spent.
      await ctx.dataSource.query(
        'UPDATE game_session SET "currentIndex" = 5 WHERE id = $1',
        [sessionId],
      );
      const afterPlaying = await catalog.drawItemIds(themeId, 5, seed, {
        excludeSeenBy: player.userId,
      });

      expect(afterPlaying).not.toEqual(dealt);
      // The one item the theme has left over is now the draw's first pick.
      expect(dealt).not.toContain(afterPlaying[0]);
    });

    /**
     * The cooldown is a window, not a tombstone. Driven through the service
     * with a fixed seed, because this is the one case whose answer has to be
     * exact: the same seed over the same pool, with the player's history first
     * inside the window and then outside it.
     */
    it('lets an item return once the cooldown has run out', async () => {
      const player = await registerPlayer(api, 'pool-device-0005', 'patient');
      const themeId = await themeIdFor('everyday-stuff');
      const seed = 'fixed-seed-for-the-cooldown-case';

      const first = await catalog.drawItemIds(themeId, 5, seed, {
        excludeSeenBy: player.userId,
      });
      await recordPlayed(player.userId, themeId, first);

      // Inside the window: the six-item theme has one unseen item left, so the
      // draw is forced — that one first, then the seen five, coldest first.
      const cooled = await catalog.drawItemIds(themeId, 5, seed, {
        excludeSeenBy: player.userId,
      });
      expect(cooled[0]).not.toBeUndefined();
      expect(first).toContain(cooled[1]);

      // Outside it, the history stops counting and the draw is the plain
      // shuffle again — identical to asking with no player at all.
      await ctx.dataSource.query(
        `UPDATE game_session SET "createdAt" = now() - interval '3650 days'
           WHERE "userId" = $1`,
        [player.userId],
      );

      const expired = await catalog.drawItemIds(themeId, 5, seed, {
        excludeSeenBy: player.userId,
      });
      const unfiltered = await catalog.drawItemIds(themeId, 5, seed, {});

      expect(expired).toEqual(unfiltered);
      expect(expired).not.toEqual(cooled);
    });

    it('applies no exclusion at all when the cooldown is switched off', async () => {
      const player = await registerPlayer(api, 'pool-device-0006', 'nocool');
      const themeId = await themeIdFor('vintage-finds');
      const seed = 'fixed-seed-for-the-disabled-case';

      const first = await catalog.drawItemIds(themeId, 5, seed, {});
      await recordPlayed(player.userId, themeId, first);

      const original = config.itemCooldownDays;
      config.itemCooldownDays = 0;
      try {
        expect(
          await catalog.drawItemIds(themeId, 5, seed, {
            excludeSeenBy: player.userId,
          }),
        ).toEqual(first);
      } finally {
        config.itemCooldownDays = original;
      }
    });
  });

  describe('the exclusions bend rather than break', () => {
    /**
     * A six-item theme cannot supply five unseen items twice over. The draw
     * must still deal a full round — a player who has seen a category is not
     * locked out of it.
     */
    it('still deals a full round when the fresh items run out', async () => {
      const player = await registerPlayer(api, 'pool-device-0007', 'grinder');

      // Played, not merely started: the pool only runs dry once the items have
      // actually been shown, so a loop that abandons its sessions would leave
      // the fallback untested.
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(await playThrough(player, 'everyday-stuff')).toHaveLength(5);
      }
    });

    /**
     * The theme picker counts items *without* the exclusions, deliberately: the
     * list is cached under one global key and digested into the client manifest
     * by `themesVersion`, so a per-player count would poison both. That is only
     * safe because the exclusions are a preference order — every theme it
     * offers can still be started, however much the player has already seen.
     */
    it('can start every theme the picker offers, however much has been played', async () => {
      const player = await registerPlayer(
        api,
        'pool-device-0008',
        'everything',
      );
      await player.api.post('/v1/sessions', { mode: 'daily' });

      const themes = await player.api.get('/v1/themes');
      expect(themes.status).toBe(200);
      expect(themes.body.length).toBeGreaterThan(0);

      // Twice through, and played out each time, so the second pass draws
      // against a history that already covers most of the catalogue — an
      // abandoned session shows nothing and would build no history at all.
      for (let pass = 0; pass < 2; pass++) {
        for (const theme of themes.body as Array<{ slug: string }>) {
          const dealt = await playThrough(player, theme.slug);
          expect({ slug: theme.slug, dealt: dealt.length }).toEqual({
            slug: theme.slug,
            dealt: config.roundsPerSession,
          });
        }
      }
    });
  });

  describe('what the exclusions must not cost', () => {
    /**
     * A release blocker, alongside `price-leak.e2e-spec.ts`. If the daily draw
     * ever picked up `excludeSeenBy`, it would not fail loudly — it would
     * quietly deal each player a different five items and turn one leaderboard
     * into a comparison of different games.
     *
     * Generated twice for the same future date, with a different player's
     * history behind each run and the row deleted in between, so the reserve
     * both runs see is identical and player history is the only thing that
     * differs. Deliberately not "two players read the same stored row": that
     * agrees whether or not the generator filtered, which is the whole question.
     */
    it('generates the daily independently of any player’s history (release blocker)', async () => {
      const date = addDays(todayUtc(), 3);

      const light = await registerPlayer(api, 'pool-device-0009', 'light');
      await startQuick(light);
      const first = (await daily.generate(date)).itemIds;

      // Same date, same reserve, a far heavier history behind the second run.
      await ctx.dataSource.query(
        'DELETE FROM daily_challenge WHERE "challengeDate" = $1',
        [date],
      );
      const heavy = await registerPlayer(api, 'pool-device-0013', 'heavy');
      for (let round = 0; round < 3; round++) await startQuick(heavy);

      expect((await daily.generate(date)).itemIds).toEqual(first);
    });

    /**
     * Rule 3. Without it the days are independent shuffles of one pool and
     * collide freely — at five items a day over a week, a catalogue this size
     * makes an overlap a near-certainty rather than a fluke. A player who has
     * sat one challenge would then be handed a price they are about to be
     * tested on again, which is exactly what the reserve exists to prevent.
     */
    it('never deals one item to two upcoming challenges', async () => {
      // Three days, not `DAILY_PREGENERATE_DAYS`: the fixture catalogue is
      // small enough that a fourth day could leave fewer than five unreserved
      // and the draw would legitimately fall through to the reserve —
      // asserting the fallback rather than the rule. Sequential, because each
      // day is only held back from the next once it has been written.
      const drawn: number[] = [];
      for (let offset = 0; offset < 3; offset++) {
        const challenge = await daily.generate(addDays(todayUtc(), offset));
        drawn.push(...challenge.itemIds);
      }

      expect(new Set(drawn).size).toBe(drawn.length);
    });

    it('deals two players the identical ordered daily', async () => {
      const grinder = await registerPlayer(api, 'pool-device-0010', 'played');
      const fresh = await registerPlayer(api, 'pool-device-0011', 'newcomer');
      await startQuick(grinder);
      await startQuick(grinder);

      const theirs = await grinder.api.post('/v1/sessions', { mode: 'daily' });
      const ours = await fresh.api.post('/v1/sessions', { mode: 'daily' });

      expect(await itemsOf(theirs.body.id as string)).toEqual(
        await itemsOf(ours.body.id as string),
      );
    });
  });

  /**
   * The other half of the daily's integrity, and the reason the reservation
   * above is worth anything: the seed used to be the date itself, which made
   * every future challenge computable offline by anyone who could guess the
   * item ids.
   */
  it('draws the daily from a seed that is not simply its date', async () => {
    const player = await registerPlayer(api, 'pool-device-0012', 'unguessable');
    await player.api.post('/v1/sessions', { mode: 'daily' });

    const [row] = await ctx.dataSource.query(
      'SELECT "challengeDate"::text AS date, seed FROM daily_challenge LIMIT 1',
    );

    expect(row.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(row.seed).not.toContain(row.date);
    expect(row.seed).not.toBe(`cashortrash:daily:${row.date as string}`);
  });

  /** Sanity: the suite is running against the configuration it thinks it is. */
  it('runs with the exclusions actually switched on', () => {
    expect(config.itemCooldownDays).toBeGreaterThan(0);
    expect(config.dailyPregenerateDays).toBeGreaterThan(0);
    expect(config.dailySeedSecret.length).toBeGreaterThanOrEqual(32);
  });
});
