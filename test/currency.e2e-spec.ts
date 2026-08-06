import { Api } from './support/api-client';
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

  it('deals the same item on a slider denominated in the chosen currency', async () => {
    const me = await player();
    const sessionId = await startQuick(me.api);

    const dollars = await me.api.get(`/v1/sessions/${sessionId}/current`);
    const euros = await me.api.get(
      `/v1/sessions/${sessionId}/current?currency=EUR`,
    );

    expect(euros.body.itemId).toBe(dollars.body.itemId);
    expect(dollars.body.currency).toBe('USD');
    expect(euros.body.currency).toBe('EUR');
    // Not the dollar bounds relabelled: converted, and then given a step
    // derived from the converted span so the slider still snaps to round euro
    // amounts rather than to the fractional shadow of a dollar one.
    expect(euros.body.sliderMinCents).not.toBe(dollars.body.sliderMinCents);
    expect(euros.body.suggestedLoCents % euros.body.incrementCents).toBe(
      euros.body.sliderMinCents % euros.body.incrementCents,
    );
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
