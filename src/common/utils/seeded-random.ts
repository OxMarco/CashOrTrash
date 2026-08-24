import { createHash, createHmac } from 'node:crypto';

/**
 * Deterministic PRNG. The daily challenge is generated from `seedForDate`, so
 * the same date always yields the same five items — the set is reproducible
 * and auditable after the fact, and regenerating it is safe.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: string) {
    const digest = createHash('sha256').update(seed).digest();
    this.state = digest.readUInt32BE(0) || 1;
  }

  /** mulberry32 — small, fast, and good enough for shuffling a catalog. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  nextInt(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  /** Fisher–Yates over a copy; the input is left alone. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  pick<T>(items: readonly T[], count: number): T[] {
    return this.shuffle(items).slice(0, count);
  }
}

/**
 * What the daily challenge is drawn from.
 *
 * Keyed, for the same reason `sliderSeed` is: the only identifier in the
 * visible scope is a calendar date. An unkeyed hash of one — which is what this
 * was — makes the draw a pure function of public inputs, and this file's PRNG
 * and shuffle are published code. Anyone who could reconstruct the active item
 * ids could compute every *future* daily offline, look the five objects up at
 * leisure, and post a perfect score to a leaderboard that is supposed to be
 * measuring whether they know what things cost.
 *
 * The date stays inside the HMAC rather than beside it, so no two dates share a
 * draw and knowing one day's five items says nothing about tomorrow's.
 *
 * Already-generated days are unaffected by a key change — `daily_challenge`
 * stores its `itemIds`, and `getOrCreate` returns the stored row rather than
 * re-deriving it — so rotating the secret cannot reshuffle a challenge somebody
 * has already played.
 *
 * The digest is 64 hex characters, which is exactly the width of the
 * `daily_challenge.seed` column it is stored in. Do not decorate it.
 */
export const seedForDate = (date: string, secret: string): string =>
  createHmac('sha256', secret)
    .update(`cashortrash:daily:${date}`)
    .digest('hex');
