import { SeededRandom } from 'src/common/utils/seeded-random';
import { createHmac } from 'node:crypto';

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
 * `FLOOR_RATIO` is proportional, so on a cheap object it lands on pennies. That
 * used to be fatal: the client rendered whole units and nothing else, so the
 * $0.30 floor a $1.15 card produced came out as "$0", and a slider whose left
 * end reads zero invites a bet of nothing, which is not a price. The client now
 * renders minor units whenever the round's increment is sub-unit, so the floor
 * only has to be a number somebody would actually write. A dime is.
 */
export const FLOOR_MIN_CENTS = 10;

/**
 * The stops a round needs to be worth dragging.
 *
 * This replaces an absolute minimum span, which was the wrong measure of the
 * right thing. `PricingService` aims for ~100 stops at every scale, so what
 * makes a slider draggable is how many stops the travel carries, not how many
 * cents it covers: a $1 item stepping a cent at a time is exactly as playable
 * as a $16M boat stepping $100,000 at a time, and an absolute span called the
 * first one broken and the second one fine.
 */
export const MIN_SLIDER_STOPS = 20;

/**
 * The cheapest object that can carry a readable slider.
 *
 * Derived rather than chosen. `rawMin` is the larger of `FLOOR_MIN_CENTS` and
 * `price − position × span`, and the feasibility rule holds `position × span ≤
 * 1 − FLOOR_RATIO`, so the proportional floor never falls below `FLOOR_RATIO ×
 * price`. Above this price the proportional floor is the binding one and every
 * draw frames the answer on the item's own scale. Below it the flat floor wins
 * instead and pins the left end at or above the answer, leaving the guard at
 * the end of `deriveSlider` to rescue a slider that should never have been
 * drawn — so that is exactly where the catalogue stops accepting items.
 */
export const MIN_IMPORT_PRICE_CENTS = FLOOR_MIN_CENTS / FLOOR_RATIO;

/**
 * The dearest object that can carry a readable slider. The mirror of the floor
 * above, and derived the same way rather than chosen.
 *
 * `sliderMaxCents` travels as an `int`, so `deriveSlider` clamps it to the
 * largest nice step that fits — `niceRound(INT32_MAX, 'down')`, which is
 * exactly $20,000,000. That clamp is applied last, so on an item priced at or
 * above it the clamp lands the top of the slider *on or below the answer* and
 * quietly undoes the guard that had just framed it: every bet is then clamped
 * into bounds that cannot contain the price, and the round is unwinnable for
 * everyone, every time, with nothing in the logs to say so.
 *
 * There is no rescue available inside the column: above this there is no nice
 * int32 number left to put above the answer. So, exactly as at the floor, this
 * is where the catalogue stops accepting items — see `rejectPrice`. Exclusive,
 * because the clamp has to leave room *above* the price, not land on it.
 */
export const MAX_IMPORT_PRICE_CENTS = niceRound(INT32_MAX, 'down');

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
  // each axis gets its full range on a good share of the items and neither is
  // systematically compressed; the split leans to position for the same reason
  // it is the one named above.
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
  // Last, and therefore able to undo the guard above — which is safe only
  // because `MAX_IMPORT_PRICE_CENTS` keeps prices this clamp could strand out
  // of the catalogue in the first place.
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
export function sliderSeed(
  scope: SliderScope,
  itemId: number,
  secret: string,
): string {
  let visibleScope: string;
  if (scope.mode === 'daily' && scope.dailyDate) {
    visibleScope = `daily:${scope.dailyDate}:${itemId}`;
  } else if (scope.mode === 'h2h' && scope.matchId) {
    visibleScope = `match:${scope.matchId}:${itemId}`;
  } else {
    visibleScope = `session:${scope.id}:${itemId}`;
  }

  return createHmac('sha256', secret).update(visibleScope).digest('hex');
}

/** Immutable slider geometry stored with a shared challenge or session. */
export function deriveSliderBoundsSet(
  scope: SliderScope,
  items: Array<{ id: number; truePriceCents: number }>,
  secret: string,
): { sliderMinCents: number[]; sliderMaxCents: number[] } {
  const bounds = items.map((item) =>
    deriveSlider(item.truePriceCents, sliderSeed(scope, item.id, secret)),
  );
  return {
    sliderMinCents: bounds.map((bound) => bound.sliderMinCents),
    sliderMaxCents: bounds.map((bound) => bound.sliderMaxCents),
  };
}
