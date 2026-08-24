import { CURRENT_SCORING } from './constants';
import { SCORING_V1 } from './constants/v1';
import { SCORING_V2 } from './constants/v2';
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

  /**
   * v1 is frozen, but it is not dead: every round persisted under it is still
   * re-scored with it, so its rules stay covered here in full. The suite below
   * names the version rather than riding on `CURRENT_SCORING`, which is what
   * lets v2 change the answers without quietly deleting v1's coverage.
   */
  const scoreV1 = (input: ScoreInput) => service.score(input, 'v1');
  const scoreV2 = (input: ScoreInput) => service.score(input, 'v2');

  describe('the design bundle worked examples', () => {
    it('reproduces the Reveal screen: 140 × 2.4 → +336', () => {
      const result = scoreV1(base());

      expect(result.hit).toBe(true);
      expect(result.basePoints).toBe(140);
      expect(result.multiplier).toBe(2.4);
      expect(result.points).toBe(336);
      expect(result.errorPct).toBe(0);
    });

    it('labels the widest bets ×1.2, as the onboarding card promises', () => {
      const result = scoreV1(
        base({ loCents: DOLLARS(50), hiCents: DOLLARS(1500) }),
      );

      expect(result.multiplier).toBe(SCORING_V1.MULT_MIN);
    });

    it('lands a perfect five-hit game around +1,700', () => {
      const perfectRound = scoreV1(base()).points;

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
      expect(scoreV1(base(over)).hit).toBe(expected);
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
      const result = scoreV1(base({ truePriceCents }));

      expect(result.hit).toBe(false);
      expect(result.basePoints).toBe(0);
      expect(result.points).toBe(0);
    });

    it('still reports the multiplier the player was shown', () => {
      const result = scoreV1(base({ truePriceCents: DOLLARS(20) }));

      expect(result.multiplier).toBe(2.4);
    });

    it('is not rescued by a theme bonus', () => {
      const result = scoreV1(
        base({ truePriceCents: DOLLARS(20), themeBonusPct: 0.1 }),
      );

      expect(result.points).toBe(0);
    });
  });

  describe('base points fall off with centre error', () => {
    it('awards BASE_MAX for a dead-centre guess', () => {
      const result = scoreV1(
        base({ loCents: DOLLARS(400), hiCents: DOLLARS(500) }),
      );

      expect(result.errorPct).toBe(0);
      expect(result.basePoints).toBe(SCORING_V1.BASE_MAX);
    });

    it('awards zero base points at exactly TOLERANCE off-centre', () => {
      // Centre must sit 40% above the true price while still containing it.
      const truePriceCents = DOLLARS(100);
      const result = scoreV1(
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
      const result = scoreV1(
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
      const result = scoreV1(
        base({
          truePriceCents: DOLLARS(100),
          loCents: DOLLARS(100),
          hiCents: DOLLARS(140), // centre $120 → +20% == TOLERANCE / 2
        }),
      );

      expect(result.basePoints).toBe(Math.round(SCORING_V1.BASE_MAX / 2));
    });

    it('signs the error: under-guessing reads negative', () => {
      const result = scoreV1(
        base({ loCents: DOLLARS(360), hiCents: DOLLARS(460) }),
      );

      expect(result.errorPct).toBeLessThan(0);
    });

    it('treats equal error above and below identically', () => {
      const under = scoreV1(
        base({
          truePriceCents: DOLLARS(100),
          loCents: DOLLARS(70),
          hiCents: DOLLARS(110), // centre $90 → −10%
        }),
      );
      const over = scoreV1(
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
      expect(service.multiplierFor(0, span, SCORING_V1)).toBe(
        SCORING_V1.MULT_MAX,
      );
    });

    it('returns MULT_MAX at the narrow threshold', () => {
      expect(
        service.multiplierFor(
          span * SCORING_V1.NARROW_WIDTH_PCT,
          span,
          SCORING_V1,
        ),
      ).toBe(SCORING_V1.MULT_MAX);
    });

    it('returns MULT_MIN at the wide threshold', () => {
      expect(
        service.multiplierFor(
          span * SCORING_V1.WIDE_WIDTH_PCT,
          span,
          SCORING_V1,
        ),
      ).toBe(SCORING_V1.MULT_MIN);
    });

    it('returns MULT_MIN for the widest possible range', () => {
      expect(service.multiplierFor(span, span, SCORING_V1)).toBe(
        SCORING_V1.MULT_MIN,
      );
    });

    it('is monotonically non-increasing as the range widens', () => {
      let previous = Number.POSITIVE_INFINITY;
      for (let width = 0; width <= span; width += span / 200) {
        const multiplier = service.multiplierFor(width, span, SCORING_V1);
        expect(multiplier).toBeLessThanOrEqual(previous);
        previous = multiplier;
      }
    });

    it('stays within [MULT_MIN, MULT_MAX] across the whole span', () => {
      for (let width = 0; width <= span; width += span / 50) {
        const multiplier = service.multiplierFor(width, span, SCORING_V1);
        expect(multiplier).toBeGreaterThanOrEqual(SCORING_V1.MULT_MIN);
        expect(multiplier).toBeLessThanOrEqual(SCORING_V1.MULT_MAX);
      }
    });

    it('rounds to the precision the client displays', () => {
      const multiplier = service.multiplierFor(span * 0.2, span, SCORING_V1);

      expect(multiplier).toBe(
        Number(multiplier.toFixed(SCORING_V1.MULTIPLIER_DECIMALS)),
      );
    });

    it('degrades safely on a zero-span slider', () => {
      expect(service.multiplierFor(0, 0, SCORING_V1)).toBe(SCORING_V1.MULT_MAX);
    });
  });

  describe('theme bonus', () => {
    it('applies the mystery mix +10% on top of the multiplier', () => {
      const plain = scoreV1(base());
      const bonus = scoreV1(base({ themeBonusPct: 0.1 }));

      expect(plain.points).toBe(336);
      expect(bonus.points).toBe(Math.round(336 * 1.1));
    });

    it('leaves points untouched at a zero bonus', () => {
      expect(scoreV1(base({ themeBonusPct: 0 })).points).toBe(336);
    });
  });

  describe('input validation', () => {
    it.each([
      ['a zero true price', { truePriceCents: 0 }],
      ['a negative true price', { truePriceCents: -1 }],
      ['a non-finite true price', { truePriceCents: Number.NaN }],
    ])('rejects %s', (_label, over) => {
      expect(() => scoreV1(base(over))).toThrow(RangeError);
    });

    it('rejects an inverted range', () => {
      expect(() =>
        scoreV1(base({ loCents: DOLLARS(500), hiCents: DOLLARS(400) })),
      ).toThrow(RangeError);
    });

    it('rejects non-finite bounds', () => {
      expect(() =>
        scoreV1(base({ hiCents: Number.POSITIVE_INFINITY })),
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
      expect(scoreV1(base()).scoringVersion).toBe(SCORING_V1.version);
    });

    it('never returns fractional points', () => {
      const result = scoreV1(
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

      const result = scoreV1(
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
      const wide = scoreV1(
        base({ loCents: DOLLARS(200), hiCents: DOLLARS(700) }),
      );
      const narrow = scoreV1(
        base({ loCents: DOLLARS(430), hiCents: DOLLARS(470) }),
      );

      expect(narrow.points).toBeGreaterThan(wide.points);
    });
  });
  /**
   * The curve leaves the server as data so the app can label the slider mid-drag
   * without keeping its own copy of these numbers — which is how the client once
   * ended up promising a multiplier the server did not pay.
   */
  describe('the curve it publishes', () => {
    it('describes the same line `multiplierFor` scores on', () => {
      const curve = service.curveFor('v1');
      const span = 100_000;

      // The two ends and a point in between, evaluated both ways.
      for (const widthPct of [
        0,
        curve.narrowWidthPct,
        0.3,
        curve.wideWidthPct,
        1,
      ]) {
        const t = Math.min(
          1,
          Math.max(
            0,
            (widthPct - curve.narrowWidthPct) /
              (curve.wideWidthPct - curve.narrowWidthPct),
          ),
        );
        const factor = 10 ** curve.decimals;
        const drawn =
          Math.round((curve.max + (curve.min - curve.max) * t) * factor) /
          factor;

        expect(service.multiplierFor(span * widthPct, span, SCORING_V1)).toBe(
          drawn,
        );
      }
    });

    it('names the version it came from, and refuses one it does not know', () => {
      expect(service.curveFor('v1').scoringVersion).toBe('v1');
      expect(() => service.curveFor('v-nope')).toThrow(RangeError);
    });
  });
  /**
   * v2: a hit is always worth something, and covering the whole board is not a
   * way to farm that. The two rules only work as a pair, so they are tested as
   * one — see `constants/v2.ts`.
   */
  describe('v2', () => {
    const span = SLIDER.sliderMaxCents - SLIDER.sliderMinCents;

    /** A bet of `widthPct` of the slider, centred on `centrePct` of the span. */
    const bet = (widthPct: number, centrePct = 0.5) => {
      const centre = SLIDER.sliderMinCents + span * centrePct;
      const half = (span * widthPct) / 2;
      return { loCents: centre - half, hiCents: centre + half };
    };

    it('is the version new rounds are scored with', () => {
      expect(scoreV2(base()).scoringVersion).toBe('v2');
      expect(service.score(base()).scoringVersion).toBe('v2');
    });

    describe('the worked examples survive the retune', () => {
      it('still reproduces the Reveal screen: 140 × 2.4 → +336', () => {
        const result = scoreV2(base());

        expect(result.basePoints).toBe(140);
        expect(result.multiplier).toBe(2.4);
        expect(result.points).toBe(336);
      });

      it('still lands a perfect five-hit game around +1,700', () => {
        expect(scoreV2(base()).points * 5).toBe(1680);
      });

      it('leaves the middle of the curve within a tenth of v1', () => {
        for (const widthPct of [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) {
          const width = span * widthPct;

          expect(
            Math.abs(
              service.multiplierFor(width, span, SCORING_V2) -
                service.multiplierFor(width, span, SCORING_V1),
            ),
          ).toBeLessThanOrEqual(0.1 + Number.EPSILON);
        }
      });
    });

    describe('a hit is never worth nothing', () => {
      it('pays the floor at exactly TOLERANCE off-centre, where v1 paid zero', () => {
        const input = base({
          truePriceCents: DOLLARS(100),
          loCents: DOLLARS(100),
          hiCents: DOLLARS(180), // centre $140 → +40%
        });

        expect(scoreV1(input).basePoints).toBe(0);
        expect(scoreV2(input).basePoints).toBe(
          SCORING_V2.BASE_MAX * SCORING_V2.HIT_FLOOR,
        );
        expect(scoreV2(input).points).toBeGreaterThan(0);
      });

      it('never drops below the floor, however far off-centre', () => {
        for (const hiDollars of [200, 400, 1000, 1400]) {
          const result = scoreV2(
            base({
              truePriceCents: DOLLARS(100),
              loCents: DOLLARS(60),
              hiCents: DOLLARS(hiDollars),
            }),
          );

          expect(result.hit).toBe(true);
          expect(result.basePoints).toBeGreaterThanOrEqual(
            SCORING_V2.BASE_MAX * SCORING_V2.HIT_FLOOR,
          );
        }
      });

      it('does not extend the floor to a miss', () => {
        const result = scoreV2(base({ truePriceCents: DOLLARS(20) }));

        expect(result.hit).toBe(false);
        expect(result.basePoints).toBe(0);
        expect(result.points).toBe(0);
      });

      it('still pays precision more than mere containment', () => {
        const sloppy = scoreV2(base(bet(0.2, 0.2)));
        const sharp = scoreV2(base(bet(0.2, (450 - 50) / 1450)));

        expect(sharp.multiplier).toBe(sloppy.multiplier);
        expect(sharp.basePoints).toBeGreaterThan(sloppy.basePoints);
      });
    });

    describe('covering the board is not a strategy', () => {
      it('keeps charging for width past the point v1 went flat', () => {
        for (const widthPct of [0.7, 0.8, 0.9, 1]) {
          const width = span * widthPct;

          expect(service.multiplierFor(width, span, SCORING_V1)).toBe(
            SCORING_V1.MULT_MIN,
          );
          expect(service.multiplierFor(width, span, SCORING_V2)).toBeLessThan(
            SCORING_V1.MULT_MIN,
          );
        }
      });

      /**
       * The invariant the floor is only safe under. Not "full-width scores less
       * on average" — outright domination: the luckiest possible full-width
       * round loses to the unluckiest hit a player could take at 70% width, so
       * there is no draw of the cards on which dragging the slider end to end
       * was the better call.
       *
       * 70% and not higher because the multiplier is rounded to a tenth before
       * it is applied: at 75% both sides round to 28 and the domination is a
       * tie. The margin is real but it is not large — widening HIT_FLOOR or
       * lifting MULT_MIN eats it, which is what this test is here to catch.
       */
      it('loses even its best round to the worst hit at 70% width', () => {
        // Best case for the lazy bet: the price sits dead centre of the board,
        // so it takes the full BASE_MAX and only the multiplier holds it down.
        const luckiest = scoreV2(
          base({
            truePriceCents: DOLLARS(775), // centre of the $50–$1,500 slider
            loCents: DOLLARS(50),
            hiCents: DOLLARS(1500),
          }),
        );

        expect(luckiest.hit).toBe(true);
        expect(luckiest.basePoints).toBe(SCORING_V2.BASE_MAX);

        // Worst case for an honest one: 70% of the board, scraping the floor.
        const worstRealHit = scoreV2(
          base({
            truePriceCents: DOLLARS(300),
            loCents: DOLLARS(50),
            hiCents: DOLLARS(1065), // $1,015 wide == 70% of the $1,450 span
          }),
        );

        expect(worstRealHit.hit).toBe(true);
        expect(worstRealHit.basePoints).toBe(
          SCORING_V2.BASE_MAX * SCORING_V2.HIT_FLOOR,
        );
        expect(luckiest.points).toBeLessThan(worstRealHit.points);
      });

      it('pays a full-width round less than a fifth of a narrow one', () => {
        const lazy = scoreV2(
          base({ loCents: DOLLARS(50), hiCents: DOLLARS(1500) }),
        );

        expect(lazy.points * 5).toBeLessThan(scoreV2(base()).points);
      });

      it('is monotonically non-increasing across the whole span', () => {
        let previous = Number.POSITIVE_INFINITY;
        for (let width = 0; width <= span; width += span / 200) {
          const multiplier = service.multiplierFor(width, span, SCORING_V2);

          expect(multiplier).toBeLessThanOrEqual(previous);
          previous = multiplier;
        }
      });
    });

    it('publishes the curve it scores on', () => {
      const curve = service.curveFor('v2');

      expect(curve.scoringVersion).toBe('v2');
      expect(curve.min).toBe(SCORING_V2.MULT_MIN);
      expect(curve.wideWidthPct).toBe(SCORING_V2.WIDE_WIDTH_PCT);

      for (const widthPct of [0, curve.narrowWidthPct, 0.3, 0.75, 1]) {
        const t = Math.min(
          1,
          Math.max(
            0,
            (widthPct - curve.narrowWidthPct) /
              (curve.wideWidthPct - curve.narrowWidthPct),
          ),
        );
        const factor = 10 ** curve.decimals;
        const drawn =
          Math.round((curve.max + (curve.min - curve.max) * t) * factor) /
          factor;

        expect(service.multiplierFor(span * widthPct, span, SCORING_V2)).toBe(
          drawn,
        );
      }
    });
  });

  /**
   * `multiplierFor` and `curveFor` both default their version argument to
   * `CURRENT_SCORING`, and every other test in this file passes one
   * explicitly — so nothing here ever ran the defaults, and the branch
   * coverage this module holds at 100% was the first to say so.
   *
   * The gap is not only arithmetic. The callers that omit the argument are the
   * live ones, so the day `CURRENT_SCORING` is repointed at v3 they all move to
   * the new curve. These tests make that move something a test states rather
   * than something a reader has to infer from a default three files away.
   */
  describe('the constants each method falls back to', () => {
    const span = SLIDER.sliderMaxCents - SLIDER.sliderMinCents;

    it('prices an unnamed multiplier on the current curve', () => {
      for (const widthPct of [0, 0.25, 0.5, 0.75, 1]) {
        expect(service.multiplierFor(span * widthPct, span)).toBe(
          service.multiplierFor(span * widthPct, span, CURRENT_SCORING),
        );
      }
    });

    it('describes the current curve when no version is named', () => {
      expect(service.curveFor()).toEqual(
        service.curveFor(CURRENT_SCORING.version),
      );
    });

    // Pinned to the literal version rather than to `CURRENT_SCORING`, which
    // would agree with itself no matter what it pointed at. Promoting a new
    // scoring version is meant to fail here and be updated deliberately.
    it('is currently v2', () => {
      expect(service.curveFor().scoringVersion).toBe(SCORING_V2.version);
    });
  });
});
