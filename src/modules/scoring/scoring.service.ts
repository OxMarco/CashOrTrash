import { Injectable } from '@nestjs/common';

import {
  CURRENT_SCORING,
  SCORING_VERSIONS,
  ScoringConstants,
} from './constants/v1';

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

    const closeness = 1 - clamp(Math.abs(errorPct) / k.TOLERANCE, 0, 1);
    const basePoints = Math.round(k.BASE_MAX * closeness);
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

  constantsFor(version: string): ScoringConstants {
    const constants = SCORING_VERSIONS[version];
    if (!constants) {
      throw new RangeError(`Unknown scoring version: ${version}`);
    }
    return constants;
  }
}
