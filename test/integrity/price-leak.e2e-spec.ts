import { instanceToPlain } from 'class-transformer';

import { Item } from '../../src/modules/catalog/entities/item.entity';
import { Api } from '../support/api-client';
import { playRound, registerPlayer } from '../support/players';
import {
  createTestApp,
  resetGameplayState,
  TestApp,
} from '../support/test-app';

/**
 * Plan §1: `truePriceCents` must never reach the client before a bet is
 * placed. A failure here is a release blocker, not a flaky test — it means a
 * player can read the answer off the wire before guessing.
 *
 * The suite scans raw response bodies rather than parsed ones. A parsed check
 * only finds a leak in a field the test thought to look at; the string scan
 * finds it in a nested object, an unexpected array, or an error message that
 * echoed the item back.
 */
describe('true price containment (release blocker)', () => {
  let ctx: TestApp;
  let api: Api;
  let prices: Map<number, number>;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetGameplayState(ctx);

    const rows = await ctx.dataSource
      .getRepository(Item)
      .createQueryBuilder('i')
      .select(['i.id', 'i.truePriceCents'])
      .getMany();
    prices = new Map(rows.map((row) => [row.id, row.truePriceCents]));

    const player = await registerPlayer(
      ctx.api,
      'leak-device-0001',
      'leaktest',
    );
    api = player.api;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  /**
   * Matched on digit boundaries so `1999` does not "find" itself inside a
   * slider bound of `19990`. Returns the offenders rather than a boolean, so a
   * failure names the price and the caller can name the endpoint.
   */
  const leakedIn = (raw: string, candidates: number[]): number[] =>
    candidates.filter((price) =>
      new RegExp(`(?<![0-9])${price}(?![0-9])`).test(raw),
    );

  const expectNoLeak = (label: string, raw: string, candidates: number[]) => {
    const found = leakedIn(raw, candidates);
    expect({ label, leaked: found }).toEqual({ label, leaked: [] });
  };

  const allPrices = () => [...prices.values()];

  describe('the scanner itself', () => {
    /**
     * A positive control. Without it, a scanner with a broken regex would pass
     * every other case in this file while proving nothing at all.
     */
    it('detects a price that really is present', async () => {
      const session = await api.post('/v1/sessions', { mode: 'daily' });
      const current = await api.get(`/v1/sessions/${session.body.id}/current`);
      const truePrice = prices.get(current.body.itemId)!;

      const reveal = await api.post(
        `/v1/sessions/${session.body.id}/rounds/0/bet`,
        {
          loCents: current.body.suggestedLoCents,
          hiCents: current.body.suggestedHiCents,
        },
      );

      // The reveal is the one endpoint allowed to carry it, and it must.
      expect(reveal.body.round.truePriceCents).toBe(truePrice);
      expect(leakedIn(reveal.raw, [truePrice])).toEqual([truePrice]);

      await resetGameplayState(ctx);
      const replacement = await registerPlayer(
        ctx.api,
        'leak-device-0001',
        'leaktest',
      );
      api = replacement.api;
    });
  });

  describe('layer 1 — the entity excludes the field', () => {
    it('drops truePriceCents and sourceUrl when an Item is serialized', async () => {
      const item = await ctx.dataSource.getRepository(Item).findOneOrFail({
        where: {},
      });

      const plain = instanceToPlain(item) as Record<string, unknown>;

      expect(plain).not.toHaveProperty('truePriceCents');
      // Provenance is excluded too: the source listing shows the price.
      expect(plain).not.toHaveProperty('sourceUrl');
      expect(plain).toHaveProperty('title');
    });
  });

  describe('layer 3 — no endpoint reachable before a bet carries any price', () => {
    it('keeps every catalogue price out of the pre-game screens', async () => {
      const endpoints = [
        '/v1/themes',
        '/v1/home',
        '/v1/me',
        '/v1/leaderboard?scope=today',
        '/v1/leaderboard?scope=week',
        '/v1/leaderboard?scope=friends',
        '/v1/usernames/availability?u=someone',
      ];

      for (const path of endpoints) {
        const response = await api.get(path);
        expect(response.status).toBe(200);
        expectNoLeak(path, response.raw, allPrices());
      }
    });

    it('keeps the daily session payload free of its own five prices', async () => {
      const session = await api.post('/v1/sessions', { mode: 'daily' });
      expect(session.status).toBe(201);

      const itemIds: number[] = await sessionItemIds(ctx, session.body.id);
      const sessionPrices = itemIds.map((id) => prices.get(id)!);

      expectNoLeak('POST /v1/sessions', session.raw, sessionPrices);

      const summary = await api.get(`/v1/sessions/${session.body.id}/summary`);
      expectNoLeak('summary before any bet', summary.raw, sessionPrices);
    });

    it('serves each round without ever revealing the item being priced', async () => {
      const session = await api.post('/v1/sessions', { mode: 'daily' });
      const sessionId = session.body.id as string;
      const itemIds = await sessionItemIds(ctx, sessionId);

      for (let index = 0; index < itemIds.length; index++) {
        const current = await api.get(`/v1/sessions/${sessionId}/current`);
        expect(current.status).toBe(200);

        // Everything not yet bet on — the current item and all those after it.
        const unrevealed = itemIds.slice(index).map((id) => prices.get(id)!);
        expectNoLeak(`round ${index} /current`, current.raw, unrevealed);
        expect(current.raw).not.toContain('truePrice');
        expect(current.raw).not.toContain('sourceUrl');

        await playRound(api, sessionId, index);
      }
    });

    it('shows only already-played prices in a mid-game summary', async () => {
      await resetGameplayState(ctx);
      const player = await registerPlayer(
        ctx.api,
        'leak-device-0002',
        'midgame',
      );
      const session = await player.api.post('/v1/sessions', { mode: 'daily' });
      const sessionId = session.body.id as string;
      const itemIds = await sessionItemIds(ctx, sessionId);

      await playRound(player.api, sessionId, 0);
      await playRound(player.api, sessionId, 1);

      const summary = await player.api.get(`/v1/sessions/${sessionId}/summary`);
      expect(summary.status).toBe(200);

      // Played rounds may show their prices — the player has seen them.
      expect(summary.body.rounds).toHaveLength(2);
      // The three still to come may not.
      expectNoLeak(
        'mid-game summary',
        summary.raw,
        itemIds.slice(2).map((id) => prices.get(id)!),
      );
    });
  });

  describe('quick and head-to-head rounds', () => {
    it('withholds the price from a quick round in progress', async () => {
      const session = await api.post('/v1/sessions', {
        mode: 'quick',
        themeSlug: 'mystery-mix',
      });
      expect(session.status).toBe(201);

      const itemIds = await sessionItemIds(ctx, session.body.id);
      expectNoLeak(
        'POST /v1/sessions quick',
        session.raw,
        itemIds.map((id) => prices.get(id)!),
      );

      const current = await api.get(`/v1/sessions/${session.body.id}/current`);
      expectNoLeak(
        'quick /current',
        current.raw,
        itemIds.map((id) => prices.get(id)!),
      );
    });

    it('withholds it from both sides of a head-to-head, including the match view', async () => {
      const guest = await registerPlayer(
        ctx.api,
        'leak-device-0003',
        'guestleak',
      );

      const match = await api.post('/v1/matches', {
        themeSlug: 'vintage-finds',
      });
      expect(match.status).toBe(201);
      await guest.api.post('/v1/matches/join', {
        inviteCode: match.body.inviteCode,
      });

      const hostSession = await api.post('/v1/sessions', {
        mode: 'h2h',
        inviteCode: match.body.inviteCode,
      });
      const itemIds = await sessionItemIds(ctx, hostSession.body.id);
      const matchPrices = itemIds.map((id) => prices.get(id)!);

      const guestSession = await guest.api.post('/v1/sessions', {
        mode: 'h2h',
        inviteCode: match.body.inviteCode,
      });
      expectNoLeak('h2h session (guest)', guestSession.raw, matchPrices);

      // The host plays first; the guest must still not see that round's price
      // in the shared match view before betting on it themselves.
      await playRound(api, hostSession.body.id, 0);

      const matchView = await guest.api.get(`/v1/matches/${match.body.id}`);
      expect(matchView.status).toBe(200);
      expectNoLeak('GET /v1/matches/:id (guest)', matchView.raw, matchPrices);

      const guestCurrent = await guest.api.get(
        `/v1/sessions/${guestSession.body.id}/current`,
      );
      expectNoLeak('h2h /current (guest)', guestCurrent.raw, matchPrices);
    });
  });

  describe('error paths', () => {
    it('does not echo the price back in a rejected bet', async () => {
      await resetGameplayState(ctx);
      const player = await registerPlayer(
        ctx.api,
        'leak-device-0004',
        'errpath',
      );
      const session = await player.api.post('/v1/sessions', { mode: 'daily' });
      const sessionId = session.body.id as string;
      const itemIds = await sessionItemIds(ctx, sessionId);
      const unrevealed = itemIds.map((id) => prices.get(id)!);

      const rejections = [
        // Outside the slider.
        { loCents: 1, hiCents: 2_000_000_000 },
        // Inverted.
        { loCents: 900, hiCents: 100 },
        // Not on the increment.
        { loCents: 1_001, hiCents: 2_003 },
      ];

      for (const bet of rejections) {
        const response = await player.api.post(
          `/v1/sessions/${sessionId}/rounds/0/bet`,
          bet,
        );
        expect(response.status).toBe(400);
        expectNoLeak(
          `rejected bet ${JSON.stringify(bet)}`,
          response.raw,
          unrevealed,
        );
      }

      // A 404 for an unknown session must not become an oracle either.
      const missing = await player.api.get(
        '/v1/sessions/00000000-0000-4000-8000-000000000000/current',
      );
      expect(missing.status).toBe(404);
      expectNoLeak('unknown session', missing.raw, allPrices());
    });
  });
});

/** The ordered item ids the server drew for a session, read from the source. */
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
