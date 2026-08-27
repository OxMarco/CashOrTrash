import { Api } from './support/api-client';
import {
  ExchangeRatesService,
  RateSnapshot,
} from '../src/modules/currency/exchange-rates.service';
import { registerPlayer } from './support/players';
import { createTestApp, resetGameplayState, TestApp } from './support/test-app';

/**
 * One price per item, in dollars, whatever the player sees.
 *
 * The catalogue stores `truePriceCents` and its slider bounds in USD and
 * nothing else, so a euro round is a conversion applied at the edge of the API
 * and undone again before anything is scored. What these specs pin down is the
 * seam that makes that safe: the slider a non-dollar round is dealt on is not
 * the dollar one, so a bet has to say which currency it was snapped in, and the
 * server has to convert it back before it validates or scores it.
 */
describe('playing in another currency', () => {
  let ctx: TestApp;
  let api: Api;
  let device = 0;

  const player = () =>
    registerPlayer(api, `currency-device-${String(++device).padStart(4, '0')}`);

  const startQuick = async (api: Api) => {
    const session = await api.post('/v1/sessions', {
      mode: 'quick',
      themeSlug: 'everyday-stuff',
    });
    expect(session.status).toBe(201);
    return session.body.id as string;
  };

  /** Same items *and* the same sliders for everyone — see the case that uses it. */
  const startDaily = async (api: Api) => {
    const session = await api.post('/v1/sessions', { mode: 'daily' });
    expect(session.status).toBe(201);
    return session.body.id as string;
  };

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

  it('publishes the currencies a round may be played in', async () => {
    const response = await (await player()).api.get('/v1/currencies');

    expect(response.status).toBe(200);
    expect(response.body.map((entry: { code: string }) => entry.code)).toEqual([
      'USD',
      'EUR',
      'GBP',
    ]);
    // The dollar is the unit prices are stored in, so it is never a rate.
    expect(
      response.body.find((entry: { code: string }) => entry.code === 'USD')
        .rate,
    ).toBe(1);
  });

  it('refuses a currency it cannot price', async () => {
    const me = await player();
    const sessionId = await startQuick(me.api);

    const response = await me.api.get(
      `/v1/sessions/${sessionId}/current?currency=BTC`,
    );

    expect(response.status).toBe(400);
  });

  it('pins the currency selected when a round is first dealt', async () => {
    const me = await player();
    const sessionId = await startQuick(me.api);

    const euros = await me.api.get(
      `/v1/sessions/${sessionId}/current?currency=EUR`,
    );
    const retriedInDollars = await me.api.get(
      `/v1/sessions/${sessionId}/current`,
    );

    expect(euros.body.currency).toBe('EUR');
    expect(retriedInDollars.body.currency).toBe('EUR');
    expect(retriedInDollars.body.itemId).toBe(euros.body.itemId);
    expect(retriedInDollars.body.sliderMinCents).toBe(
      euros.body.sliderMinCents,
    );
    expect(retriedInDollars.body.sliderMaxCents).toBe(
      euros.body.sliderMaxCents,
    );
    expect(euros.body.suggestedLoCents % euros.body.incrementCents).toBe(
      euros.body.sliderMinCents % euros.body.incrementCents,
    );
  });

  /**
   * A prefetch, a resume-from-home fetch, a retry — plenty of clients hit
   * `/current` with no `?currency` and mean nothing by it. Treating that as a
   * choice would pin the round to dollars and then reject the euro bet the
   * player actually goes on to place.
   */
  it('lets an explicit choice override a currency nothing asked for', async () => {
    const me = await player();
    const sessionId = await startQuick(me.api);

    const prefetch = await me.api.get(`/v1/sessions/${sessionId}/current`);
    const euros = await me.api.get(
      `/v1/sessions/${sessionId}/current?currency=EUR`,
    );

    expect(prefetch.body.currency).toBe('USD');
    expect(euros.body.currency).toBe('EUR');

    const bet = await me.api.post(`/v1/sessions/${sessionId}/rounds/0/bet`, {
      loCents: euros.body.suggestedLoCents,
      hiCents: euros.body.suggestedHiCents,
      currency: 'EUR',
    });

    expect(bet.status).toBe(200);
  });

  /**
   * Switching currency is re-dealing the round, not buying a new one: the grid
   * changes because the scale does, and the shot clock keeps running from the
   * first deal. A bet is checked against whichever quote was served last, so a
   * player who switches has to re-read the round before betting.
   */
  it('re-deals the round when the player switches currency', async () => {
    const me = await player();
    const sessionId = await startQuick(me.api);

    const euros = await me.api.get(
      `/v1/sessions/${sessionId}/current?currency=EUR`,
    );
    const stale = await me.api.post(`/v1/sessions/${sessionId}/rounds/0/bet`, {
      loCents: euros.body.suggestedLoCents,
      hiCents: euros.body.suggestedHiCents,
      currency: 'GBP',
    });
    expect(stale.status).toBe(400);

    const pounds = await me.api.get(
      `/v1/sessions/${sessionId}/current?currency=GBP`,
    );
    expect(pounds.body.currency).toBe('GBP');
    expect(pounds.body.itemId).toBe(euros.body.itemId);
    // The same round, so the deadline is the one set on the first deal —
    // switching currency must not hand the player a fresh clock.
    expect(pounds.body.expiresAt).toEqual(euros.body.expiresAt);

    const bet = await me.api.post(`/v1/sessions/${sessionId}/rounds/0/bet`, {
      loCents: pounds.body.suggestedLoCents,
      hiCents: pounds.body.suggestedHiCents,
      currency: 'GBP',
    });
    expect(bet.status).toBe(200);
    expect(bet.body.currency).toBe('GBP');
  });

  it('keeps the dealt quote when live exchange rates change', async () => {
    const me = await player();
    const sessionId = await startQuick(me.api);
    const exchange = ctx.app.get(ExchangeRatesService);
    const original = exchange.current();

    try {
      const round = await me.api.get(
        `/v1/sessions/${sessionId}/current?currency=EUR`,
      );
      const [pinned] = await ctx.dataSource.query(
        'SELECT "currentExchangeRate" AS rate FROM game_session WHERE id = $1',
        [sessionId],
      );

      (exchange as unknown as { snapshot: RateSnapshot }).snapshot = {
        ...original,
        rates: { ...original.rates, EUR: original.rates.EUR * 1.5 },
      };

      const retry = await me.api.get(
        `/v1/sessions/${sessionId}/current?currency=EUR`,
      );
      expect(retry.body.sliderMinCents).toBe(round.body.sliderMinCents);
      expect(retry.body.sliderMaxCents).toBe(round.body.sliderMaxCents);

      const reveal = await me.api.post(
        `/v1/sessions/${sessionId}/rounds/0/bet`,
        {
          loCents: round.body.suggestedLoCents,
          hiCents: round.body.suggestedHiCents,
          currency: 'EUR',
        },
      );
      expect(reveal.status).toBe(200);

      const [stored] = await ctx.dataSource.query(
        'SELECT "exchangeRate" AS rate FROM session_round WHERE "sessionId" = $1 AND "roundIndex" = 0',
        [sessionId],
      );
      expect(Number(stored.rate)).toBe(Number(pinned.rate));
      expect(Number(stored.rate)).toBe(original.rates.EUR);
    } finally {
      (exchange as unknown as { snapshot: RateSnapshot }).snapshot = original;
    }
  });

  /**
   * Played as the daily rather than a quick round, and that is load-bearing.
   *
   * Sliders are drawn per round now, seeded on whatever scope is being compared
   * — so two *quick* sessions get deliberately different scales and "the same
   * bet on the same item" cannot be expressed at all. The daily is the case
   * where the scale is guaranteed identical for every player, which is exactly
   * the fixed ground this comparison needs.
   */
  it('scores a euro bet against the stored dollar price', async () => {
    const inEuros = await player();
    const inDollars = await player();
    const euroSession = await startDaily(inEuros.api);
    const dollarSession = await startDaily(inDollars.api);

    const euroRound = await inEuros.api.get(
      `/v1/sessions/${euroSession}/current?currency=EUR`,
    );
    const dollarRound = await inDollars.api.get(
      `/v1/sessions/${dollarSession}/current`,
    );

    // The full width of each slider, which is the one range that means the
    // same thing in both currencies: the euro bounds *are* the dollar bounds
    // converted, so betting end to end is the identical bet expressed twice.
    //
    // Not the suggested range, though it reads like the obvious choice. Each
    // currency snaps its suggestion to its own increment grid — anchored at its
    // own minimum — so the two land on genuinely different ranges, and any
    // difference in points would say nothing about whether conversion leaked.
    const euroReveal = await inEuros.api.post(
      `/v1/sessions/${euroSession}/rounds/0/bet`,
      {
        loCents: euroRound.body.sliderMinCents,
        hiCents: euroRound.body.sliderMaxCents,
        currency: 'EUR',
      },
    );
    const dollarReveal = await inDollars.api.post(
      `/v1/sessions/${dollarSession}/rounds/0/bet`,
      {
        loCents: dollarRound.body.sliderMinCents,
        hiCents: dollarRound.body.sliderMaxCents,
      },
    );

    expect(euroReveal.status).toBe(200);
    expect(euroReveal.body.currency).toBe('EUR');
    // The same bet on the same item, expressed twice. Points are a function of
    // the dollar price, so a currency that changed the score would mean the
    // conversion had leaked into the rules.
    expect(euroReveal.body.round.hit).toBe(dollarReveal.body.round.hit);
    expect(euroReveal.body.round.points).toBe(dollarReveal.body.round.points);
    // The reveal is denominated too, or the player would be shown the answer
    // to a round they played in a different currency.
    expect(euroReveal.body.round.truePriceCents).not.toBe(
      dollarReveal.body.round.truePriceCents,
    );
  });

  it('reads a euro bet back in euros from the summary', async () => {
    const me = await player();
    const sessionId = await startQuick(me.api);
    const round = await me.api.get(
      `/v1/sessions/${sessionId}/current?currency=EUR`,
    );
    const bet = {
      loCents: round.body.suggestedLoCents,
      hiCents: round.body.suggestedHiCents,
      currency: 'EUR' as const,
    };
    await me.api.post(`/v1/sessions/${sessionId}/rounds/0/bet`, bet);

    const summary = await me.api.get(
      `/v1/sessions/${sessionId}/summary?currency=EUR`,
    );

    expect(summary.body.currency).toBe('EUR');
    // Within a minor unit: the bet was stored in dollars and converted back,
    // and rounding happens in both directions.
    expect(
      Math.abs(summary.body.rounds[0].loCents - bet.loCents),
    ).toBeLessThanOrEqual(1);
  });

  it('refuses a euro bet that falls off the euro slider', async () => {
    const me = await player();
    const sessionId = await startQuick(me.api);
    const round = await me.api.get(
      `/v1/sessions/${sessionId}/current?currency=EUR`,
    );

    const response = await me.api.post(
      `/v1/sessions/${sessionId}/rounds/0/bet`,
      {
        loCents: round.body.sliderMinCents,
        hiCents: round.body.sliderMaxCents * 4,
        currency: 'EUR',
      },
    );

    expect(response.status).toBe(400);
  });

  it('still refuses a dollar bet that is not on a stop', async () => {
    const me = await player();
    const sessionId = await startQuick(me.api);
    const round = await me.api.get(`/v1/sessions/${sessionId}/current`);

    // Dollars are the stored unit, so their grid is exact and the original
    // contract is unchanged by any of the above.
    const response = await me.api.post(
      `/v1/sessions/${sessionId}/rounds/0/bet`,
      {
        loCents: round.body.suggestedLoCents + 1,
        hiCents: round.body.suggestedHiCents,
      },
    );

    expect(response.status).toBe(400);
  });
});
