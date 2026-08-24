import type { ScoringConstants } from './types';

/**
 * Scoring constants, version 2 — two changes to v1, aimed at one complaint and
 * one exploit that turn out to be the same bug from opposite ends.
 *
 * **A hit is never worth nothing (`HIT_FLOOR`).** Under v1 base points fell to
 * zero at TOLERANCE, so a player could catch the price inside their range and
 * be shown "+0" next to a green dot. It read as broken, and defensibly so: the
 * range contained the answer. A hit now banks a quarter of BASE_MAX however far
 * off-centre it was, and the remaining three quarters are still earned by
 * precision.
 *
 * **The widest bet is no longer safe (`WIDE_WIDTH_PCT`, `MULT_MIN`).** The floor
 * alone would have made "drag the slider end to end" a strategy: a guaranteed
 * hit, every round, for free. v1 could not push back because its curve went flat
 * at 60% width — from there to the full board the multiplier stopped falling, so
 * the last 40% of width was given away. v2 stretches the same line to the full
 * span and drops its far end to ×0.2, which prices the safety that v1 handed
 * over.
 *
 * Below 60% width — where bets actually get placed — the two curves never differ
 * by more than a tenth, which is one step of what the player is shown:
 *
 *   width   10%    20%    40%    60%    70%    85%   100%
 *   v1      ×2.4   ×2.1   ×1.7   ×1.2   ×1.2   ×1.2   ×1.2
 *   v2      ×2.4   ×2.1   ×1.7   ×1.2   ×0.9   ×0.6   ×0.2
 *
 * so both design-bundle worked examples still hold exactly (a dead-centre
 * $380–$520 bet on the $50–$1,500 slider is still 140 × 2.4 → +336, and a
 * perfect five-hit game is still ~+1,700). What changed is only the stretch v1
 * was not charging for.
 *
 * The result is that going end-to-end is dominated outright rather than merely
 * discouraged: the *best* a full-width bet can do is 140 × 0.2 = 28, which loses
 * to the *worst* a hit at 70% width or under can do (35 × 0.9 = 32). No luck of
 * the draw makes the lazy bet the right one. `scoring.service.spec.ts` pins that
 * as an invariant rather than a comment.
 */
export const SCORING_V2 = {
  version: 'v2',

  BASE_MAX: 140,
  TOLERANCE: 0.4,

  /** A hit off by TOLERANCE or more still banks 25% of BASE_MAX — 35 points. */
  HIT_FLOOR: 0.25,

  MULT_MIN: 0.2,
  MULT_MAX: 2.5,
  NARROW_WIDTH_PCT: 0.05,

  /** No flat spot: the curve keeps falling until the bet covers the board. */
  WIDE_WIDTH_PCT: 1,

  MULTIPLIER_DECIMALS: 1,
} as const satisfies ScoringConstants;
