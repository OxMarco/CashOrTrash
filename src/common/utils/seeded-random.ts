import { createHash } from 'node:crypto';

/**
 * Deterministic PRNG. The daily challenge is generated from `hash(date)`, so
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
 * The daily draw is a pure function of this string, so changing the prefix
 * changes which items every future date deals. Already-generated days are
 * unaffected — `daily_challenge` stores its `itemIds`, and `getOrCreate`
 * returns the stored row rather than re-deriving it — so a rename cannot
 * reshuffle a challenge somebody has already played.
 */
export const seedForDate = (date: string): string =>
  `cashortrash:daily:${date}`;
