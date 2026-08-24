/**
 * The shape every scoring version fills in.
 *
 * Explicit rather than `typeof SCORING_V1`, because the versions are no longer
 * the same numbers retuned — v2 adds a floor v1 does not have — and a structural
 * type derived from one of them makes the others its dialects.
 */
export interface ScoringConstants {
  version: string;

  /** Points awarded for a dead-centre guess, before the multiplier. */
  BASE_MAX: number;

  /** Relative centre error at which base points reach their floor. */
  TOLERANCE: number;

  /**
   * Share of `BASE_MAX` a hit banks no matter how far off-centre it was, as a
   * fraction. `0` restores the original rule, where a hit past `TOLERANCE`
   * scored nothing at all.
   */
  HIT_FLOOR: number;

  /** Multiplier at or below `NARROW_WIDTH_PCT` — the "narrow & bold" end. */
  MULT_MAX: number;

  /** Multiplier at or above `WIDE_WIDTH_PCT` — the widest bet on the board. */
  MULT_MIN: number;

  /** Range width, as a fraction of the slider span, that earns `MULT_MAX`. */
  NARROW_WIDTH_PCT: number;

  /** Range width, as a fraction of the slider span, that earns `MULT_MIN`. */
  WIDE_WIDTH_PCT: number;

  /** Decimals the multiplier is rounded to *before* it is applied. */
  MULTIPLIER_DECIMALS: number;
}
