/**
 * Stable machine-readable slugs for the refusals a *player* can hit while a
 * round is on screen — the `type` of the problem document, never its prose.
 *
 * The same contract `username.service.ts` already uses, and for the same
 * reason: the client picks its own copy, in its own language, from the slug.
 * `title` stays prose for a log, and rewording it must not change what a
 * shipped app shows.
 *
 * Without these every refusal on the bet path arrived as `bad-request` or
 * `conflict`, which the app could only render as "something in there isn't
 * valid" — the same sentence for a bet placed a fraction too fast, a round
 * that had already moved on, and a game that was over.
 *
 * Mirrored in the app's `features/game/gameErrors.ts`. Retire a slug there
 * before here; an unrecognised one degrades to the generic sentence, so a
 * client older than the server is never worse off than it was.
 */

/** The bet arrived before the round's dwell floor (`MIN_ROUND_SECONDS`). */
export const ROUND_TOO_FAST = 'round-too-fast';
/** A bet on a round this session never dealt — nothing has been served. */
export const ROUND_NOT_SERVED = 'round-not-served';
/** The round index bet on is not the one the session is standing on. */
export const ROUND_OUT_OF_ORDER = 'round-out-of-order';
/** The round moved on underneath a fetch that was racing a bet. */
export const ROUND_MOVED_ON = 'round-moved-on';
/** No such round index in this session at all. */
export const ROUND_UNKNOWN = 'round-unknown';
/** The round was dealt in one currency and bet in another. */
export const ROUND_CURRENCY_MISMATCH = 'round-currency-mismatch';
/** The game is over: complete, abandoned, or out of rounds. */
export const SESSION_FINISHED = 'session-finished';
/** The two bounds do not describe a range on this round's slider. */
export const BET_OFF_SLIDER = 'bet-off-slider';

export type RoundProblemCode =
  | typeof ROUND_TOO_FAST
  | typeof ROUND_NOT_SERVED
  | typeof ROUND_OUT_OF_ORDER
  | typeof ROUND_MOVED_ON
  | typeof ROUND_UNKNOWN
  | typeof ROUND_CURRENCY_MISMATCH
  | typeof SESSION_FINISHED
  | typeof BET_OFF_SLIDER;

/**
 * The body Nest hands the exception filter, which reads `error` as the
 * problem `type` and `message` as its `title`.
 */
export function roundProblem(
  code: RoundProblemCode,
  message: string,
): { error: RoundProblemCode; message: string } {
  return { error: code, message };
}
