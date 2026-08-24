import { SCORING_V1 } from './v1';
import { SCORING_V2 } from './v2';

import type { ScoringConstants } from './types';

export type { ScoringConstants } from './types';
export { SCORING_V1 } from './v1';
export { SCORING_V2 } from './v2';

/**
 * The constant set new rounds are scored with.
 *
 * Retuning is additive — add `v3.ts`, point this at it — and never a rescoring
 * of history: every SessionRound persists the version that produced it, and
 * `SCORING_VERSIONS` keeps that version around to be re-scored with.
 */
export const CURRENT_SCORING: ScoringConstants = SCORING_V2;

/** Every set we can still re-score with, keyed by the persisted version. */
export const SCORING_VERSIONS: Record<string, ScoringConstants> = {
  [SCORING_V1.version]: SCORING_V1,
  [SCORING_V2.version]: SCORING_V2,
};
