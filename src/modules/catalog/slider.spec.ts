import {
  deriveSlider,
  MIN_IMPORT_PRICE_CENTS,
  MIN_SLIDER_SPAN_CENTS,
  sliderSeed,
} from './slider';

const scope = (over: Partial<Parameters<typeof sliderSeed>[0]> = {}) => ({
  mode: 'quick',
  id: 'session-a',
  dailyDate: null,
  matchId: null,
  ...over,
});

describe('deriveSlider', () => {
  it('always frames the answer without touching it', () => {
    for (let i = 0; i < 500; i += 1) {
      const price = 2_000 + i * 9_973;
      const { sliderMinCents, sliderMaxCents } = deriveSlider(price, `s${i}`);

      expect(sliderMinCents).toBeGreaterThanOrEqual(0);
      expect(sliderMinCents).toBeLessThan(price);
      expect(sliderMaxCents).toBeGreaterThan(price);
    }
  });

  it('never opens on a floor that renders as $0', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(
        deriveSlider(MIN_IMPORT_PRICE_CENTS + i, `floor${i}`).sliderMinCents,
      ).toBeGreaterThanOrEqual(100);
    }
  });

  it('leaves enough travel to be worth dragging at the import floor', () => {
    for (let i = 0; i < 200; i += 1) {
      const { sliderMinCents, sliderMaxCents } = deriveSlider(
        MIN_IMPORT_PRICE_CENTS,
        `span${i}`,
      );
      expect(sliderMaxCents - sliderMinCents).toBeGreaterThanOrEqual(
        MIN_SLIDER_SPAN_CENTS,
      );
    }
  });

  it('is a pure function of its seed', () => {
    expect(deriveSlider(100_000, 'same')).toEqual(
      deriveSlider(100_000, 'same'),
    );
    expect(deriveSlider(100_000, 'a')).not.toEqual(deriveSlider(100_000, 'b'));
  });

  it('stays inside the int32 the wire carries', () => {
    expect(
      deriveSlider(2_000_000_000, 'huge').sliderMaxCents,
    ).toBeLessThanOrEqual(2_147_483_647);
  });

  /**
   * Both axes have to be genuinely drawn, because a player can learn either
   * one. Two earlier versions derived one from the other and leaked: knowing
   * the width to within a third, or that the answer always sat in the lower
   * quarter, is most of a guess.
   *
   * These assert spread, not uniformity. The bounds snap to a ladder of round
   * numbers, so the widths they produce do pile onto round multiples — that is
   * `niceRound` doing its job, and it is why the measure here is the p10–p90
   * range rather than the share near any one value.
   */
  it('draws the width across a wide range', () => {
    const spans = sample((lo, hi) => (hi - lo) / 100_000);

    expect(percentile(spans, 0.9) / percentile(spans, 0.1)).toBeGreaterThan(2);
    expect(new Set(spans.map((s) => s.toFixed(2))).size).toBeGreaterThan(20);
  });

  it('draws where the answer sits across a wide range', () => {
    const positions = sample((lo, hi) => (100_000 - lo) / (hi - lo));

    expect(
      percentile(positions, 0.9) - percentile(positions, 0.1),
    ).toBeGreaterThan(0.3);

    // No single tenth of the track may hold the answer often enough for a
    // fixed-anchor guess to beat the field.
    expect(busiestBand(positions, 0.1)).toBeLessThan(0.4);
  });
});

function sample(measure: (lo: number, hi: number) => number): number[] {
  return Array.from({ length: 2_000 }, (_, i) => {
    const { sliderMinCents, sliderMaxCents } = deriveSlider(100_000, `d${i}`);
    return measure(sliderMinCents, sliderMaxCents);
  });
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(p * sorted.length)];
}

/** The fullest fixed-width bucket, as a share of the sample. */
function busiestBand(values: number[], width: number): number {
  const counts = new Map<number, number>();
  for (const value of values) {
    const bucket = Math.floor(value / width);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return Math.max(...counts.values()) / values.length;
}

describe('sliderSeed', () => {
  it('varies per session in quick play, so a repeat item plays differently', () => {
    expect(sliderSeed(scope({ id: 'a' }), 7)).not.toBe(
      sliderSeed(scope({ id: 'b' }), 7),
    );
  });

  it('varies per item within one session', () => {
    expect(sliderSeed(scope(), 7)).not.toBe(sliderSeed(scope(), 8));
  });

  /**
   * The daily challenge is the same five items for everyone, one attempt each,
   * feeding a leaderboard. Two players on different scales for the same object
   * are not playing the same game, and the board would be ranking them anyway.
   */
  it('is identical for every player on a given daily challenge', () => {
    const alice = scope({
      mode: 'daily',
      id: 'alice',
      dailyDate: '2026-08-05',
    });
    const bob = scope({ mode: 'daily', id: 'bob', dailyDate: '2026-08-05' });

    expect(sliderSeed(alice, 7)).toBe(sliderSeed(bob, 7));
    expect(deriveSlider(500_000, sliderSeed(alice, 7))).toEqual(
      deriveSlider(500_000, sliderSeed(bob, 7)),
    );
  });

  it('still differs between one day and the next', () => {
    expect(
      sliderSeed(scope({ mode: 'daily', dailyDate: '2026-08-05' }), 7),
    ).not.toBe(
      sliderSeed(scope({ mode: 'daily', dailyDate: '2026-08-06' }), 7),
    );
  });

  /** Same reasoning as the daily: both players are being compared directly. */
  it('is identical for both players in a head-to-head', () => {
    const host = scope({ mode: 'h2h', id: 'host', matchId: 'match-1' });
    const guest = scope({ mode: 'h2h', id: 'guest', matchId: 'match-1' });

    expect(sliderSeed(host, 7)).toBe(sliderSeed(guest, 7));
  });

  it('differs between two matches on the same item', () => {
    expect(sliderSeed(scope({ mode: 'h2h', matchId: 'm1' }), 7)).not.toBe(
      sliderSeed(scope({ mode: 'h2h', matchId: 'm2' }), 7),
    );
  });

  it('falls back to the session when a shared scope is somehow missing', () => {
    expect(sliderSeed(scope({ mode: 'daily', dailyDate: null }), 7)).toBe(
      sliderSeed(scope({ mode: 'quick' }), 7),
    );
  });
});
