import { DailyChallenge } from '../src/modules/daily/entities/daily-challenge.entity';
import { DailyService } from '../src/modules/daily/daily.service';
import { todayUtc } from '../src/common/utils/date.util';
import { Api } from './support/api-client';
import { registerPlayer } from './support/players';
import { createTestApp, resetGameplayState, TestApp } from './support/test-app';

/**
 * Phase 3 exit criterion: two users fetching today's challenge receive an
 * identical, identically-ordered item set. "Same items for everyone" is the
 * whole premise of a shared daily leaderboard — if the draw drifts between
 * players, the ranking compares scores from different games.
 */
describe('daily challenge', () => {
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

  it('gives two players the identical ordered set', async () => {
    const [one, two] = await Promise.all([
      registerPlayer(api, 'daily-device-0001', 'playerone'),
      registerPlayer(api, 'daily-device-0002', 'playertwo'),
    ]);

    const [first, second] = await Promise.all([
      one.api.post('/v1/sessions', { mode: 'daily' }),
      two.api.post('/v1/sessions', { mode: 'daily' }),
    ]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).not.toBe(second.body.id);

    const [firstItems, secondItems] = await Promise.all([
      sessionItemIds(ctx, first.body.id),
      sessionItemIds(ctx, second.body.id),
    ]);

    // Order matters as much as membership: round 3 must be the same item for
    // both, or "I got 4/5" is not a comparable claim.
    expect(firstItems).toEqual(secondItems);
    expect(firstItems).toHaveLength(5);
  });

  it('creates exactly one challenge row even under a concurrent first request', async () => {
    const [one, two, three] = await Promise.all([
      registerPlayer(api, 'daily-device-0003'),
      registerPlayer(api, 'daily-device-0004'),
      registerPlayer(api, 'daily-device-0005'),
    ]);

    await Promise.all([
      one.api.post('/v1/sessions', { mode: 'daily' }),
      two.api.post('/v1/sessions', { mode: 'daily' }),
      three.api.post('/v1/sessions', { mode: 'daily' }),
    ]);

    const rows = await ctx.dataSource
      .getRepository(DailyChallenge)
      .find({ where: { challengeDate: todayUtc() } });

    expect(rows).toHaveLength(1);
  });

  /**
   * The seed is stored so a challenge can be audited — "why did everyone get
   * the toaster on the 4th" has an answer that does not require rerunning the
   * generator and hoping it is still deterministic.
   */
  it('regenerates the same draw from the recorded seed', async () => {
    const daily = ctx.app.get(DailyService);
    const date = '2026-03-14';

    const generated = await daily.generate(date);
    expect(generated.seed).toBe(`cashortrash:daily:${date}`);

    await ctx.dataSource
      .getRepository(DailyChallenge)
      .delete({ challengeDate: date });

    const regenerated = await daily.generate(date);

    expect(regenerated.itemIds).toEqual(generated.itemIds);
  });

  it('draws a different set for a different date', async () => {
    const daily = ctx.app.get(DailyService);

    const [a, b] = await Promise.all([
      daily.generate('2026-04-01'),
      daily.generate('2026-04-02'),
    ]);

    expect(a.itemIds).not.toEqual(b.itemIds);
  });

  it('prepares tomorrow ahead of time and is safe to run twice', async () => {
    const daily = ctx.app.get(DailyService);

    const firstRun = await daily.ensureUpcoming();
    const secondRun = await daily.ensureUpcoming();

    // The first run generates whatever is missing; the second finds nothing
    // to do, which is what makes the scheduled job safe on a retry.
    expect(firstRun.length).toBeGreaterThan(0);
    expect(secondRun).toEqual([]);
  });

  describe('the home screen', () => {
    it('reports the countdown and the pre-game call to action', async () => {
      const player = await registerPlayer(api, 'daily-device-0006', 'homeuser');

      const home = await player.api.get('/v1/home');

      expect(home.status).toBe(200);
      expect(home.body.greeting).toContain('Homeuser');
      expect(home.body.daily.challengeDate).toBe(todayUtc());
      expect(home.body.daily.secondsUntilReset).toBeGreaterThan(0);
      expect(home.body.daily.secondsUntilReset).toBeLessThanOrEqual(86_400);
      expect(home.body.daily.roundsPlayed).toBe(0);
      expect(home.body.daily.isComplete).toBe(false);
      expect(home.body.daily.ctaLabel).toBe('Play today’s five');
    });

    it('switches to "continue" mid-game and to the result when finished', async () => {
      const player = await registerPlayer(
        api,
        'daily-device-0007',
        'progressor',
      );
      const session = await player.api.post('/v1/sessions', { mode: 'daily' });
      const sessionId = session.body.id as string;

      const { playRound } = await import('./support/players');
      await playRound(player.api, sessionId, 0);

      const midGame = await player.api.get('/v1/home');
      expect(midGame.body.daily.roundsPlayed).toBe(1);
      expect(midGame.body.daily.ctaLabel).toBe('Continue · round 2');

      for (let index = 1; index < session.body.roundCount; index++) {
        await playRound(player.api, sessionId, index);
      }

      const finished = await player.api.get('/v1/home');
      expect(finished.body.daily.isComplete).toBe(true);
      expect(finished.body.daily.ctaLabel).toBe('See today’s result');
    });
  });

  describe('the theme picker', () => {
    it('lists the seeded themes with their item counts', async () => {
      const player = await registerPlayer(api, 'daily-device-0008');

      const themes = await player.api.get('/v1/themes');

      expect(themes.status).toBe(200);
      expect(themes.body.length).toBeGreaterThanOrEqual(5);

      for (const theme of themes.body) {
        expect(theme.slug).toEqual(expect.any(String));
        expect(theme.itemCount).toBeGreaterThan(0);
      }

      const mystery = themes.body.find((theme: any) => theme.isMystery);
      expect(mystery).toBeDefined();
      // The mystery mix pays a bonus for playing without a category hint.
      expect(mystery.bonusPct).toBeGreaterThan(0);
    });
  });
});

async function sessionItemIds(
  ctx: TestApp,
  sessionId: string,
): Promise<number[]> {
  const [row] = await ctx.dataSource.query(
    'SELECT "itemIds" FROM game_session WHERE id = $1',
    [sessionId],
  );

  return row.itemIds.map(Number);
}
