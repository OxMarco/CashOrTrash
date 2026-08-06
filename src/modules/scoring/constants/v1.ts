/**
 * Scoring constants, version 1.
 *
 * Every SessionRound persists the version that produced it, so retuning this
 * curve is an additive change (add `v2.ts`, point CURRENT_SCORING at it) and
 * never a rescoring of historical leaderboards.
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

  /** Points awarded for a dead-centre guess, before the multiplier. */
  BASE_MAX: 140,

  /**
   * Relative centre error at which base points reach zero. A hit whose centre
   * is >40% off necessarily came from a very wide range, which is already
   * earning the minimum multiplier.
   */
  TOLERANCE: 0.4,

  /** Multiplier at or above WIDE_WIDTH_PCT — the "wide & safe" end. */
  MULT_MIN: 1.2,

  /** Multiplier at or below NARROW_WIDTH_PCT — the "narrow & bold" end. */
  MULT_MAX: 2.5,

  /** Range width, as a fraction of the slider span, that earns MULT_MAX. */
  NARROW_WIDTH_PCT: 0.05,

  /** Range width, as a fraction of the slider span, that earns MULT_MIN. */
  WIDE_WIDTH_PCT: 0.6,

  /**
   * The multiplier is rounded before it is applied, not after. The client
   * shows "×2.4"; scoring with the unrounded 2.39 would mean the reveal screen
   * quietly disagreeing with the arithmetic the player just watched.
   */
  MULTIPLIER_DECIMALS: 1,
} as const;

export type ScoringConstants = typeof SCORING_V1;

/** The constant set new rounds are scored with. */
export const CURRENT_SCORING = SCORING_V1;

/** Every set we can still re-score with, keyed by the persisted version. */
export const SCORING_VERSIONS: Record<string, ScoringConstants> = {
  [SCORING_V1.version]: SCORING_V1,
};
