import { SeededRandom } from 'src/common/utils/seeded-random';

/**
 * Which items a round may be built from, and in what order of preference.
 *
 * The draw used to be one line — shuffle the active catalogue, take five —
 * because the catalogue was one undifferentiated pool. It is not: the reveal at
 * the end of a round hands the player the true price, which makes every mode
 * except the daily a way of *learning* prices, and the daily a way of being
 * *tested* on them. Drawing all three from the same unrestricted pool means a
 * quick round can teach a player the answer to a challenge they have not sat
 * yet, and a script that plays quick rounds all night can learn all of them.
 *
 * So two kinds of item are held back from quick and head-to-head draws:
 *
 * - **reserved** — belongs to a daily challenge dated today or later. Dealing
 *   one gives away an answer to a leaderboard round nobody has played.
 * - **recently seen** — this player has been dealt it inside the cooldown. They
 *   already know the price, so the round is a formality rather than a guess.
 *
 * Neither is a hard exclusion, because the catalogue is finite and a player who
 * has exhausted it must still be able to press Play. They are a preference
 * order, which is what `selectFromTiers` implements.
 */

export interface PoolRow {
  id: number;
  /** Belongs to today's daily, or one already generated for a future day. */
  reserved: boolean;
  /** When this player was last dealt it, or null if not inside the cooldown. */
  lastSeenAt: Date | null;
}

export interface DrawOptions {
  /** Hold back items reserved for today's and any pre-generated daily. */
  reserveDaily?: boolean;
  /** Hold back items dealt to this player inside the cooldown window. */
  excludeSeenBy?: number | null;
}

export interface DrawSelection {
  ids: number[];
  /**
   * True when the draw ran out of unreserved items and had to deal one held
   * for a future daily. Not an error — the alternative is refusing to start a
   * round — but it means the reserve is not doing its job, and the caller
   * should say so where an operator will see it.
   */
  dippedIntoReserve: boolean;
}

/**
 * Fill `count` items from the pool, best tier first.
 *
 * | tier | contents                        | order                |
 * |------|---------------------------------|----------------------|
 * | 0    | not reserved, not recently seen | shuffled             |
 * | 1    | not reserved, recently seen     | coldest seen first   |
 * | 2    | reserved, recently seen         | coldest seen first   |
 * | 3    | reserved, not seen              | shuffled             |
 *
 * Tier 2 sits above tier 3 because a reserved item this player has *already*
 * seen leaks nothing new — they know that price either way — while tier 3 is
 * the one case that actively hands away an unseen daily answer.
 *
 * Within the seen tiers, coldest first: if an item has to come back, it should
 * be the one furthest from memory.
 *
 * **The RNG is consumed by tier 0 before anything else touches it.** With no
 * exclusions every row lands in tier 0, in the `id ASC` order the query
 * guarantees, so this reduces exactly to `shuffle(pool).slice(0, count)` — the
 * draw as it was, bit for bit, for the same seed. Do not shuffle the assembled
 * result, and do not draw from `rng` before tier 0.
 *
 * That ordering is also what keeps the daily generator deterministic now that
 * it passes `reserveDaily`: its pool is a function of the calendar rather than
 * of the caller, so two replicas generating the same date see the same tiers
 * and consume the same stream. A challenge already written is never re-derived
 * — `daily_challenge` stores its `itemIds` — so this only has to agree with
 * itself within one generation, not across the life of the catalogue.
 *
 * Returns null when the whole pool is smaller than `count`; the caller owns the
 * error, because only it knows what was being drawn for.
 */
export function selectFromTiers(
  pool: readonly PoolRow[],
  count: number,
  rng: SeededRandom,
): DrawSelection | null {
  if (pool.length < count) return null;

  const tier0: PoolRow[] = [];
  const tier1: PoolRow[] = [];
  const tier2: PoolRow[] = [];
  const tier3: PoolRow[] = [];

  for (const row of pool) {
    if (row.reserved) {
      (row.lastSeenAt ? tier2 : tier3).push(row);
    } else {
      (row.lastSeenAt ? tier1 : tier0).push(row);
    }
  }

  // Both shuffles happen up front and in this order so the RNG stream depends
  // only on the pool, never on how many items a given tier happened to supply.
  const fresh = rng.shuffle(tier0);
  const reservedUnseen = rng.shuffle(tier3);

  const ordered = [
    ...fresh,
    ...byColdest(tier1),
    ...byColdest(tier2),
    ...reservedUnseen,
  ].slice(0, count);

  return {
    ids: ordered.map((row) => row.id),
    dippedIntoReserve: ordered.some((row) => row.reserved),
  };
}

/** Oldest sighting first, with the id as a stable tiebreak. */
const byColdest = (rows: PoolRow[]): PoolRow[] =>
  [...rows].sort(
    (a, b) =>
      (a.lastSeenAt?.getTime() ?? 0) - (b.lastSeenAt?.getTime() ?? 0) ||
      a.id - b.id,
  );
