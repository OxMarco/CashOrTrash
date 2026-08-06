import { SCORING_V1 } from './constants/v1';
import { ScoreInput, ScoringService } from './scoring.service';

const DOLLARS = (n: number) => Math.round(n * 100);

/** The gameplay screen's slider: $50 – $1,500. */
const SLIDER = {
  sliderMinCents: DOLLARS(50),
  sliderMaxCents: DOLLARS(1500),
};

const base = (over: Partial<ScoreInput> = {}): ScoreInput => ({
  truePriceCents: DOLLARS(450),
  loCents: DOLLARS(380),
  hiCents: DOLLARS(520),
  ...SLIDER,
  themeBonusPct: 0,
  ...over,
});

describe('ScoringService', () => {
  let service: ScoringService;

  beforeEach(() => {
    service = new ScoringService();
  });

  describe('the design bundle worked examples', () => {
    it('reproduces the Reveal screen: 140 × 2.4 → +336', () => {
      const result = service.score(base());

      expect(result.hit).toBe(true);
      expect(result.basePoints).toBe(140);
      expect(result.multiplier).toBe(2.4);
      expect(result.points).toBe(336);
      expect(result.errorPct).toBe(0);
    });

    it('labels the widest bets ×1.2, as the onboarding card promises', () => {
      const result = service.score(
        base({ loCents: DOLLARS(50), hiCents: DOLLARS(1500) }),
      );

      expect(result.multiplier).toBe(SCORING_V1.MULT_MIN);
    });

    it('lands a perfect five-hit game around +1,700', () => {
      const perfectRound = service.score(base()).points;

      expect(perfectRound * 5).toBe(1680);
    });
  });

  describe('hit detection', () => {
    const cases: Array<[string, Partial<ScoreInput>, boolean]> = [
      ['true price strictly inside', {}, true],
      ['true price on the lower edge', { truePriceCents: DOLLARS(380) }, true],
      ['true price on the upper edge', { truePriceCents: DOLLARS(520) }, true],
      ['one cent below the range', { truePriceCents: DOLLARS(380) - 1 }, false],
      ['one cent above the range', { truePriceCents: DOLLARS(520) + 1 }, false],
      [
        'zero-width range exactly on the price',
        { loCents: DOLLARS(450), hiCents: DOLLARS(450) },
        true,
      ],
      [
        'zero-width range one cent off',
        { loCents: DOLLARS(450) + 1, hiCents: DOLLARS(450) + 1 },
        false,
      ],
    ];

    it.each(cases)('%s → hit=%s', (_label, over, expected) => {
      expect(service.score(base(over)).hit).toBe(expected);
    });
  });

  describe('a miss scores zero', () => {
    // README is authoritative over the summary screen's placeholder rows,
    // which award points on missed items. See IMPLEMENTATION_PLAN §10.
    it.each([
      ['far below', DOLLARS(20)],
      ['just below', DOLLARS(379)],
      ['just above', DOLLARS(521)],
      ['far above', DOLLARS(9000)],
    ])('%s the range → +0', (_label, truePriceCents) => {
      const result = service.score(base({ truePriceCents }));

      expect(result.hit).toBe(false);
      expect(result.basePoints).toBe(0);
      expect(result.points).toBe(0);
    });

    it('still reports the multiplier the player was shown', () => {
      const result = service.score(base({ truePriceCents: DOLLARS(20) }));

      expect(result.multiplier).toBe(2.4);
    });

    it('is not rescued by a theme bonus', () => {
      const result = service.score(
        base({ truePriceCents: DOLLARS(20), themeBonusPct: 0.1 }),
      );

      expect(result.points).toBe(0);
    });
  });

  describe('base points fall off with centre error', () => {
    it('awards BASE_MAX for a dead-centre guess', () => {
      const result = service.score(
        base({ loCents: DOLLARS(400), hiCents: DOLLARS(500) }),
      );

      expect(result.errorPct).toBe(0);
      expect(result.basePoints).toBe(SCORING_V1.BASE_MAX);
    });

    it('awards zero base points at exactly TOLERANCE off-centre', () => {
      // Centre must sit 40% above the true price while still containing it.
      const truePriceCents = DOLLARS(100);
      const result = service.score(
        base({
          truePriceCents,
          loCents: DOLLARS(100),
          hiCents: DOLLARS(180), // centre $140 → +40%
        }),
      );

      expect(result.hit).toBe(true);
      expect(result.errorPct).toBeCloseTo(SCORING_V1.TOLERANCE, 10);
      expect(result.basePoints).toBe(0);
      expect(result.points).toBe(0);
    });

    it('clamps rather than going negative beyond TOLERANCE', () => {
      const result = service.score(
        base({
          truePriceCents: DOLLARS(100),
          loCents: DOLLARS(100),
          hiCents: DOLLARS(1000), // centre $550 → +450%
        }),
      );

      expect(result.hit).toBe(true);
      expect(result.basePoints).toBe(0);
      expect(result.points).toBe(0);
    });

    it('halves base points at half of TOLERANCE', () => {
      const result = service.score(
        base({
          truePriceCents: DOLLARS(100),
          loCents: DOLLARS(100),
          hiCents: DOLLARS(140), // centre $120 → +20% == TOLERANCE / 2
        }),
      );

      expect(result.basePoints).toBe(Math.round(SCORING_V1.BASE_MAX / 2));
    });

    it('signs the error: under-guessing reads negative', () => {
      const result = service.score(
        base({ loCents: DOLLARS(360), hiCents: DOLLARS(460) }),
      );

      expect(result.errorPct).toBeLessThan(0);
    });

    it('treats equal error above and below identically', () => {
      const under = service.score(
        base({
          truePriceCents: DOLLARS(100),
          loCents: DOLLARS(70),
          hiCents: DOLLARS(110), // centre $90 → −10%
        }),
      );
      const over = service.score(
        base({
          truePriceCents: DOLLARS(100),
          loCents: DOLLARS(90),
          hiCents: DOLLARS(130), // centre $110 → +10%
        }),
      );

      expect(under.basePoints).toBe(over.basePoints);
    });
  });

  describe('multiplier by range narrowness', () => {
    const span = SLIDER.sliderMaxCents - SLIDER.sliderMinCents;

    it('returns MULT_MAX for a zero-width range', () => {
      expect(service.multiplierFor(0, span)).toBe(SCORING_V1.MULT_MAX);
    });

    it('returns MULT_MAX at the narrow threshold', () => {
      expect(
        service.multiplierFor(span * SCORING_V1.NARROW_WIDTH_PCT, span),
      ).toBe(SCORING_V1.MULT_MAX);
    });

    it('returns MULT_MIN at the wide threshold', () => {
      expect(
        service.multiplierFor(span * SCORING_V1.WIDE_WIDTH_PCT, span),
      ).toBe(SCORING_V1.MULT_MIN);
    });

    it('returns MULT_MIN for the widest possible range', () => {
      expect(service.multiplierFor(span, span)).toBe(SCORING_V1.MULT_MIN);
    });

    it('is monotonically non-increasing as the range widens', () => {
      let previous = Number.POSITIVE_INFINITY;
      for (let width = 0; width <= span; width += span / 200) {
        const multiplier = service.multiplierFor(width, span);
        expect(multiplier).toBeLessThanOrEqual(previous);
        previous = multiplier;
      }
    });

    it('stays within [MULT_MIN, MULT_MAX] across the whole span', () => {
      for (let width = 0; width <= span; width += span / 50) {
        const multiplier = service.multiplierFor(width, span);
        expect(multiplier).toBeGreaterThanOrEqual(SCORING_V1.MULT_MIN);
        expect(multiplier).toBeLessThanOrEqual(SCORING_V1.MULT_MAX);
      }
    });

    it('rounds to the precision the client displays', () => {
      const multiplier = service.multiplierFor(span * 0.2, span);

      expect(multiplier).toBe(
        Number(multiplier.toFixed(SCORING_V1.MULTIPLIER_DECIMALS)),
      );
    });

    it('degrades safely on a zero-span slider', () => {
      expect(service.multiplierFor(0, 0)).toBe(SCORING_V1.MULT_MAX);
    });
  });

  describe('theme bonus', () => {
    it('applies the mystery mix +10% on top of the multiplier', () => {
      const plain = service.score(base());
      const bonus = service.score(base({ themeBonusPct: 0.1 }));

      expect(plain.points).toBe(336);
      expect(bonus.points).toBe(Math.round(336 * 1.1));
    });

    it('leaves points untouched at a zero bonus', () => {
      expect(service.score(base({ themeBonusPct: 0 })).points).toBe(336);
    });
  });

  describe('input validation', () => {
    it.each([
      ['a zero true price', { truePriceCents: 0 }],
      ['a negative true price', { truePriceCents: -1 }],
      ['a non-finite true price', { truePriceCents: Number.NaN }],
    ])('rejects %s', (_label, over) => {
      expect(() => service.score(base(over))).toThrow(RangeError);
    });

    it('rejects an inverted range', () => {
      expect(() =>
        service.score(base({ loCents: DOLLARS(500), hiCents: DOLLARS(400) })),
      ).toThrow(RangeError);
    });

    it('rejects non-finite bounds', () => {
      expect(() =>
        service.score(base({ hiCents: Number.POSITIVE_INFINITY })),
      ).toThrow(RangeError);
    });

    it('rejects an unknown scoring version', () => {
      expect(() => service.score(base(), 'v99')).toThrow(RangeError);
    });

    it('resolves a known scoring version', () => {
      expect(service.constantsFor('v1')).toBe(SCORING_V1);
    });
  });

  describe('result invariants', () => {
    it('always stamps the scoring version', () => {
      expect(service.score(base()).scoringVersion).toBe(SCORING_V1.version);
    });

    it('never returns fractional points', () => {
      const result = service.score(
        base({
          loCents: DOLLARS(371),
          hiCents: DOLLARS(533),
          themeBonusPct: 0.1,
        }),
      );

      expect(Number.isInteger(result.points)).toBe(true);
      expect(Number.isInteger(result.basePoints)).toBe(true);
    });

    it('never awards more than BASE_MAX × MULT_MAX × (1 + bonus)', () => {
      const ceiling = Math.round(
        SCORING_V1.BASE_MAX * SCORING_V1.MULT_MAX * 1.1,
      );

      const result = service.score(
        base({
          truePriceCents: DOLLARS(450),
          loCents: DOLLARS(450),
          hiCents: DOLLARS(450),
          themeBonusPct: 0.1,
        }),
      );

      expect(result.points).toBe(ceiling);
    });

    it('rewards the narrower of two equally-centred hits', () => {
      const wide = service.score(
        base({ loCents: DOLLARS(200), hiCents: DOLLARS(700) }),
      );
      const narrow = service.score(
        base({ loCents: DOLLARS(430), hiCents: DOLLARS(470) }),
      );

      expect(narrow.points).toBeGreaterThan(wide.points);
    });
  });
});
