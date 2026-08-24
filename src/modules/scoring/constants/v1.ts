import type { ScoringConstants } from './types';

/**
 * Scoring constants, version 1. Frozen: rounds scored under it stay scored
 * under it, which is what keeps historical leaderboards meaningful.
 *
 * The numbers are pinned against the two worked examples in the design bundle
 * rather than invented:
 *
 *   Reveal screen:  "You · 140 × 2.4 → +336" on a dead-centre guess
 *                   → BASE_MAX = 140, and the multiplier shown to the player
 *                     is the multiplier applied (see MULTIPLIER_DECIMALS).
 *   Gameplay screen: range $380–$520 on a $50–$1,500 slider is labelled
 *                   "Narrow bet · ×2.4 multiplier"
 *                   → widthPct 0.0966 must land on 2.4.
 *   Onboarding:     "Wide & safe ×1.2" vs "Narrow & bold ×2.4".
 *
 * A perfect five-hit game therefore lands around +1,700, which matches the
 * order of magnitude of the prototype's summary total.
 */
export const SCORING_V1 = {
  version: 'v1',

  BASE_MAX: 140,

  /**
   * Relative centre error at which base points reach zero. A hit whose centre
   * is >40% off necessarily came from a very wide range, which is already
   * earning the minimum multiplier.
   */
  TOLERANCE: 0.4,

  /**
   * v1 has no floor: past TOLERANCE a hit scores nothing, which is the rule v2
   * exists to replace. Present here so both versions share one code path.
   */
  HIT_FLOOR: 0,

  MULT_MIN: 1.2,
  MULT_MAX: 2.5,
  NARROW_WIDTH_PCT: 0.05,

  /**
   * Past 60% width the curve goes flat, so the widest bet on the board pays the
   * same 1.2 as a merely wide one. v2 removes that flat spot.
   */
  WIDE_WIDTH_PCT: 0.6,

  /**
   * The multiplier is rounded before it is applied, not after. The client
   * shows "×2.4"; scoring with the unrounded 2.39 would mean the reveal screen
   * quietly disagreeing with the arithmetic the player just watched.
   */
  MULTIPLIER_DECIMALS: 1,
} as const satisfies ScoringConstants;
