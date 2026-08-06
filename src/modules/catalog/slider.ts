import { SeededRandom } from 'src/common/utils/seeded-random';

/**
 * The scale a round is played on.
 *
 * Drawn when the round is dealt rather than stored on the item, so the same
 * object does not always come with the same slider. A player who has seen a
 * Daytona before should have to price it again, not remember where the answer
 * sat last time.
 *
 * That makes the *seed* the load-bearing decision, not the drawing — see
 * `sliderSeed`.
 */

const INT32_MAX = 2_147_483_647;

/**
 * The stops a hand-drawn scale would use. A slider running to 1,730,000 reads
 * as machine output; one running to 2,000,000 reads as a number somebody chose.
 */
const NICE_STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 10];

export function niceRound(value: number, direction: 'down' | 'up'): number {
  if (value <= 0) return 0;

  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const ladder = direction === 'down' ? [...NICE_STEPS].reverse() : NICE_STEPS;

  for (const step of ladder) {
    const candidate = step * magnitude;
    if (direction === 'down' ? candidate <= value : candidate >= value) {
      return candidate;
    }
  }

  return value;
}

/** Where the answer sits along the travel, as a fraction of it. */
const POSITION_MIN = 0.1;
const POSITION_MAX = 0.75;

/** Total travel, as a multiple of the true price. Sampled in log space. */
const SPAN_MIN = 1.2;
const SPAN_MAX = 5;

/**
 * The floor sits at least this fraction of the true price below it, i.e.
 * `position × span ≤ 1 - FLOOR_RATIO`.
 *
 * Zero would be the only value arithmetic requires — a floor below it is
 * negative and the column refuses it. But bare feasibility produced sliders
 * like "$300 to $125,000" for an $86,300 boat: whenever `position × span`
 * landed near 1 the floor collapsed to a rounding artifact. A tenth of the
 * answer is a floor that reads as a number somebody chose, at every scale in
 * the catalogue, and it costs almost nothing in variety.
 */
const FLOOR_RATIO = 0.1;

/**
 * And never below this, whatever the ratio works out to.
 *
 * `FLOOR_RATIO` is proportional, so on a cheap object it still lands on
 * pennies: a $1.15 card produced a floor of $0.30, which the client renders as
 * "$0" — and a slider whose left end reads zero invites a bet of nothing, which
 * is not a price. One dollar is the smallest number that still reads as one.
 */
const FLOOR_MIN_CENTS = 100;

/**
 * The travel a round needs to be playable.
 *
 * An item too cheap to carry a $1 floor and a readable span cannot produce a
 * good round at any seed, which is why `CatalogImportService` refuses to import
 * one rather than bending the slider around it. Exported so the import can
 * apply the same number this does.
 */
export const MIN_SLIDER_SPAN_CENTS = 2_000;

/**
 * The cheapest object that can carry a readable slider.
 *
 * The narrowest span this can draw is `SPAN_MIN × price`, so a price below
 * `MIN_SLIDER_SPAN_CENTS / SPAN_MIN` cannot clear the bar however the draw
 * falls. Rounded up to a whole $20, because a bound derived to the cent implies
 * a precision that is not there.
 */
export const MIN_IMPORT_PRICE_CENTS = 2_000;

export interface SliderBounds {
  sliderMinCents: number;
  sliderMaxCents: number;
}

/**
 * A slider that frames the price without giving it away.
 *
 * A slider has exactly two degrees of freedom, and a player can learn either
 * one: **where** the answer sits along the travel, and **how wide** the travel
 * is relative to the answer. Both have to be genuinely random, because either
 * one being predictable is a price leak. So both are sampled directly, and
 * neither is left to fall out of the other.
 *
 * That is worth spelling out, because two earlier versions of this function got
 * it wrong in the same way — by *deriving* one axis instead of drawing it:
 *
 * 1. Drawing the bounds (true ÷ b to true × a) and letting position fall out.
 *    A slider cannot start below zero, so any band wide enough to be
 *    interesting leaves the answer in the lower third: position landed at
 *    20–30% almost every time, and a narrow guess anchored a quarter along beat
 *    the field knowing nothing about the object.
 * 2. Drawing position and letting *span* fall out. Span became a ratio of two
 *    uniforms, which is not uniform: 45% of sliders came out within ±28% of
 *    1.4× the true price. Knowing the width to within a third is most of a
 *    guess once you have a feel for the category.
 *
 * The one coupling below is arithmetic, not taste: the floor cannot go below
 * zero, so `position × span ≤ 1`. A wide span therefore cannot also put the
 * answer near the top. Rather than reject and resample — which would bias both
 * distributions — the span is drawn from whatever remains feasible for the
 * position already chosen.
 *
 * Span is drawn in log space because it is a scale: the catalogue runs from a
 * €270 watch to a $16.9M boat, and a multiplier drawn uniformly would cluster
 * at the wide end of whatever range it was given.
 */
export function deriveSlider(
  truePriceCents: number,
  seed: string,
): SliderBounds {
  const rng = new SeededRandom(`cashortrash:slider:${seed}`);

  // Which axis is drawn freely, decided per round.
  //
  // Whichever one is drawn second has to fit inside what the first left
  // feasible, so it is always the more squeezed of the two. Fixing that order
  // makes one axis systematically narrower across the whole catalogue — drawing
  // position first pins span near 1.7x on two rounds in three; drawing span
  // first does the same thing to position, which is the worse of the two
  // because position is what a fixed-anchor guess exploits. Alternating means
  // each axis gets its full range on about half the items and neither is
  // systematically compressed.
  const positionFirst = rng.next() < 0.6;

  const drawPosition = (max: number) =>
    POSITION_MIN + rng.next() * (Math.max(POSITION_MIN, max) - POSITION_MIN);

  const drawSpan = (max: number) =>
    Math.exp(
      Math.log(SPAN_MIN) +
        rng.next() * (Math.log(Math.max(SPAN_MIN, max)) - Math.log(SPAN_MIN)),
    );

  let position: number;
  let spanMultiple: number;

  if (positionFirst) {
    position = drawPosition(POSITION_MAX);
    spanMultiple = drawSpan(Math.min(SPAN_MAX, (1 - FLOOR_RATIO) / position));
  } else {
    spanMultiple = drawSpan(SPAN_MAX);
    position = drawPosition(
      Math.min(POSITION_MAX, (1 - FLOOR_RATIO) / spanMultiple),
    );
  }

  const span = truePriceCents * spanMultiple;
  const rawMin = Math.max(FLOOR_MIN_CENTS, truePriceCents - position * span);

  let min = niceRound(rawMin, 'down');
  let max = niceRound(rawMin + span, 'up');

  // Rounding to a nice step can push a bound past the answer it was meant to
  // frame. Both of these keep the round winnable, which the CHECK constraint
  // that used to guard the stored columns can no longer do for us.
  if (min >= truePriceCents) min = niceRound(truePriceCents / 2, 'down');
  if (max <= truePriceCents) max = niceRound(truePriceCents * 2, 'up');
  if (max > INT32_MAX) max = niceRound(INT32_MAX, 'down');

  return { sliderMinCents: Math.round(min), sliderMaxCents: Math.round(max) };
}

/** The modes a session can be played in, as far as seeding is concerned. */
export interface SliderScope {
  mode: string;
  id: string;
  dailyDate: string | null;
  matchId: string | null;
}

/**
 * What the slider for a round is drawn from.
 *
 * The seed is the *shared-fate scope*, not the session, and that distinction is
 * the whole point of this function. Two players who are being compared must be
 * compared on the same scale:
 *
 * - **daily** — one challenge, the same five items for everyone, one attempt
 *   each, feeding a leaderboard. Seeding per session would hand one player a
 *   $15k–$25k slider on the same watch another got $5k–$40k on. Both scores
 *   land on the same board, and the board would be comparing two different
 *   games. So the seed is the date, and every player that day gets the scale.
 * - **h2h** — two players, one match, and the premise is that they face the
 *   same rounds. The seed is the match.
 * - **quick** — nobody is being compared, so the seed is the session and the
 *   same item genuinely plays differently every time it comes up.
 *
 * The item id is always part of the seed, so the five rounds of one session do
 * not share a draw.
 */
export function sliderSeed(scope: SliderScope, itemId: number): string {
  if (scope.mode === 'daily' && scope.dailyDate) {
    return `daily:${scope.dailyDate}:${itemId}`;
  }
  if (scope.mode === 'h2h' && scope.matchId) {
    return `match:${scope.matchId}:${itemId}`;
  }
  return `session:${scope.id}:${itemId}`;
}
