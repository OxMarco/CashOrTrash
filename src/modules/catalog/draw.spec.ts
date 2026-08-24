import { SeededRandom } from 'src/common/utils/seeded-random';
import { PoolRow, selectFromTiers } from './draw';

const AT = (iso: string) => new Date(iso);

const row = (
  id: number,
  overrides: Partial<Omit<PoolRow, 'id'>> = {},
): PoolRow => ({
  id,
  reserved: false,
  lastSeenAt: null,
  ...overrides,
});

/** The pool as the query returns it: active items, ascending by id. */
const pool = (...rows: PoolRow[]): PoolRow[] =>
  [...rows].sort((a, b) => a.id - b.id);

describe('selectFromTiers', () => {
  const seeded = () => new SeededRandom('cashortrash:test:draw');

  /**
   * The load-bearing case: tagging the pool must not change how the RNG is
   * consumed when there is nothing to hold back. Every caller's draw is seeded,
   * so a tier structure that spent the stream differently would silently
   * reshuffle a set somebody was relying on being stable — which is why the
   * shuffles happen up front and in a fixed order.
   */
  it('is identical to a plain shuffle when nothing is held back', () => {
    const rows = pool(...Array.from({ length: 40 }, (_, i) => row(i + 1)));

    const drawn = selectFromTiers(rows, 5, seeded());
    const plain = seeded().pick(
      rows.map((r) => r.id),
      5,
    );

    expect(drawn?.ids).toEqual(plain);
    expect(drawn?.dippedIntoReserve).toBe(false);
  });

  it('prefers items that are neither reserved nor recently seen', () => {
    const rows = pool(
      row(1, { reserved: true }),
      row(2, { lastSeenAt: AT('2026-08-01T00:00:00Z') }),
      row(3),
      row(4),
      row(5, { reserved: true, lastSeenAt: AT('2026-08-01T00:00:00Z') }),
    );

    const drawn = selectFromTiers(rows, 2, seeded());

    expect(drawn?.ids.sort()).toEqual([3, 4]);
    expect(drawn?.dippedIntoReserve).toBe(false);
  });

  it('falls back to seen items before reserved ones, coldest first', () => {
    const rows = pool(
      row(1),
      row(2, { lastSeenAt: AT('2026-08-05T00:00:00Z') }),
      row(3, { lastSeenAt: AT('2026-08-01T00:00:00Z') }),
      row(4, { lastSeenAt: AT('2026-08-03T00:00:00Z') }),
      row(5, { reserved: true }),
    );

    const drawn = selectFromTiers(rows, 4, seeded());

    // One fresh item, then the seen ones oldest-sighting first. The reserved
    // item is still untouched with four to find.
    expect(drawn?.ids).toEqual([1, 3, 4, 2]);
    expect(drawn?.dippedIntoReserve).toBe(false);
  });

  /**
   * A reserved item the player has already seen leaks nothing new — they know
   * that price either way. An unseen reserved item is the one case that hands
   * away an answer to a challenge nobody has sat, so it goes last.
   */
  it('deals a seen reserved item before an unseen one', () => {
    const rows = pool(
      row(1, { reserved: true }),
      row(2, { reserved: true, lastSeenAt: AT('2026-08-01T00:00:00Z') }),
    );

    const drawn = selectFromTiers(rows, 1, seeded());

    expect(drawn?.ids).toEqual([2]);
    expect(drawn?.dippedIntoReserve).toBe(true);
  });

  it('reports when a draw had to reach into the reserve', () => {
    const rows = pool(row(1), row(2, { reserved: true }));

    expect(selectFromTiers(rows, 1, seeded())?.dippedIntoReserve).toBe(false);
    expect(selectFromTiers(rows, 2, seeded())?.dippedIntoReserve).toBe(true);
  });

  /**
   * Exclusions are a preference order, not a filter: a player who has seen the
   * whole catalogue must still be able to press Play.
   */
  it('still fills a round when every item is excluded', () => {
    const rows = pool(
      ...Array.from({ length: 6 }, (_, i) =>
        row(i + 1, {
          reserved: true,
          lastSeenAt: AT('2026-08-01T00:00:00Z'),
        }),
      ),
    );

    expect(selectFromTiers(rows, 5, seeded())?.ids).toHaveLength(5);
  });

  it('returns null only when the pool itself is too small', () => {
    expect(selectFromTiers(pool(row(1), row(2)), 5, seeded())).toBeNull();
  });
});
