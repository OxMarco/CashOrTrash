import { Injectable } from '@nestjs/common';

import {
  CURRENT_SCORING,
  SCORING_VERSIONS,
  ScoringConstants,
} from './constants';

export interface ScoreInput {
  truePriceCents: number;
  loCents: number;
  hiCents: number;
  sliderMinCents: number;
  sliderMaxCents: number;
  /** 0.1 == +10%. Mystery mix is the only theme carrying one in v1. */
  themeBonusPct: number;
}

export interface ScoreResult {
  hit: boolean;
  multiplier: number;
  basePoints: number;
  points: number;
  /** Signed relative error of the range centre. Negative = under-guessed. */
  errorPct: number;
  scoringVersion: string;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * Pure domain logic: no I/O, no framework surface, no clock. Everything it
 * needs arrives in the argument, which is what makes exhaustive table-driven
 * testing cheap and makes the scoring rules reviewable in one sitting.
 */
@Injectable()
export class ScoringService {
  score(
    input: ScoreInput,
    version: string = CURRENT_SCORING.version,
  ): ScoreResult {
    const k = this.constantsFor(version);
    const {
      truePriceCents,
      loCents,
      hiCents,
      sliderMinCents,
      sliderMaxCents,
      themeBonusPct,
    } = input;

    if (!Number.isFinite(truePriceCents) || truePriceCents <= 0) {
      throw new RangeError('truePriceCents must be a positive number');
    }
    if (!Number.isFinite(loCents) || !Number.isFinite(hiCents)) {
      throw new RangeError('loCents and hiCents must be finite numbers');
    }
    if (loCents > hiCents) {
      throw new RangeError('loCents must not exceed hiCents');
    }

    const multiplier = this.multiplierFor(
      hiCents - loCents,
      sliderMaxCents - sliderMinCents,
      k,
    );

    const center = (loCents + hiCents) / 2;
    // Signed, so downstream analytics can tell "always guesses low" from noise.
    const errorPct = (center - truePriceCents) / truePriceCents;

    const hit = loCents <= truePriceCents && truePriceCents <= hiCents;
    if (!hit) {
      // README is authoritative: miss the range entirely and score zero.
      // The multiplier still comes back because the player was shown it.
      return {
        hit: false,
        multiplier,
        basePoints: 0,
        points: 0,
        errorPct,
        scoringVersion: k.version,
      };
    }

    // Precision earns everything above HIT_FLOOR; containing the price at all
    // earns the floor itself. Under a version with no floor (v1) this is the
    // original `BASE_MAX × closeness`, which is why both share the line.
    //
    // The floor is only safe to pay because the multiplier curve charges for
    // width all the way to the full board — see v2's note. Raising HIT_FLOOR
    // without checking MULT_MIN is how "bet the whole slider" becomes the
    // dominant strategy.
    const closeness = 1 - clamp(Math.abs(errorPct) / k.TOLERANCE, 0, 1);
    const basePoints = Math.round(
      k.BASE_MAX * (k.HIT_FLOOR + (1 - k.HIT_FLOOR) * closeness),
    );
    const points = Math.round(basePoints * multiplier * (1 + themeBonusPct));

    return {
      hit: true,
      multiplier,
      basePoints,
      points,
      errorPct,
      scoringVersion: k.version,
    };
  }

  /**
   * Exposed so the gameplay screen can label the slider live without the
   * client re-deriving — and drift from — the curve.
   */
  multiplierFor(
    rangeWidthCents: number,
    sliderSpanCents: number,
    k: ScoringConstants = CURRENT_SCORING,
  ): number {
    const widthPct =
      sliderSpanCents > 0 ? clamp(rangeWidthCents / sliderSpanCents, 0, 1) : 0;

    const t = clamp(
      (widthPct - k.NARROW_WIDTH_PCT) / (k.WIDE_WIDTH_PCT - k.NARROW_WIDTH_PCT),
      0,
      1,
    );

    return roundTo(
      k.MULT_MAX + (k.MULT_MIN - k.MULT_MAX) * t,
      k.MULTIPLIER_DECIMALS,
    );
  }

  /**
   * The multiplier curve as data, for a client to draw the live slider label
   * with.
   *
   * `multiplierFor` above is the same curve as behaviour, and a client cannot
   * call it — which is exactly how a second, drifting copy of these five numbers
   * ended up in the app. Handing them over is the narrowest thing that removes
   * the reason to reimplement them: enough to label a bet mid-drag, and nothing
   * that would let a client decide what a round is worth.
   */
  curveFor(version: string = CURRENT_SCORING.version): {
    max: number;
    min: number;
    narrowWidthPct: number;
    wideWidthPct: number;
    decimals: number;
    scoringVersion: string;
  } {
    const k = this.constantsFor(version);

    return {
      max: k.MULT_MAX,
      min: k.MULT_MIN,
      narrowWidthPct: k.NARROW_WIDTH_PCT,
      wideWidthPct: k.WIDE_WIDTH_PCT,
      decimals: k.MULTIPLIER_DECIMALS,
      scoringVersion: k.version,
    };
  }

  constantsFor(version: string): ScoringConstants {
    // `hasOwn` before the index, because the argument is a string that arrives
    // from outside: this is the seam a re-scoring pass reaches through, and
    // what it would hand over is `session_round.scoringVersion` read back from
    // the database. A bare lookup resolves `toString` and `constructor` off
    // the prototype and returns a *function* — truthy, so the guard below
    // passes, and every constant then reads `undefined` and scores NaN.
    if (!Object.hasOwn(SCORING_VERSIONS, version)) {
      throw new RangeError(`Unknown scoring version: ${version}`);
    }
    return SCORING_VERSIONS[version];
  }
}
