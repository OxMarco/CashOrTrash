import { SeededRandom, seedForDate } from './seeded-random';

/**
 * The daily draw is a pure function of its seed, so the seed is the only thing
 * standing between a player and next Thursday's five items. These cases are
 * about that and nothing else — the shuffle itself is exercised through the
 * catalogue's draw tests.
 */
describe('seedForDate', () => {
  const SECRET = 'a-secret-at-least-thirty-two-characters-long';
  const OTHER = 'a-different-secret-also-thirty-two-chars-long';
  const DATE = '2026-08-09';

  it('produces a 64-character hex digest, the width of the stored column', () => {
    expect(seedForDate(DATE, SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable, so regenerating a day deals the day it already dealt', () => {
    expect(seedForDate(DATE, SECRET)).toBe(seedForDate(DATE, SECRET));
  });

  it('no longer echoes its input, which is what made it predictable', () => {
    expect(seedForDate(DATE, SECRET)).not.toContain(DATE);
  });

  /**
   * The release blocker. Everything in the visible scope is public — the date
   * is on a calendar — so if the seed could be derived without the secret,
   * every future challenge could be computed offline and looked up at leisure.
   */
  it('cannot be derived without the secret', () => {
    expect(seedForDate(DATE, SECRET)).not.toBe(seedForDate(DATE, OTHER));
  });

  it('gives adjacent days unrelated seeds', () => {
    expect(seedForDate('2026-08-09', SECRET)).not.toBe(
      seedForDate('2026-08-10', SECRET),
    );
  });

  it('draws a different five items under a different secret', () => {
    const pool = Array.from({ length: 200 }, (_, i) => i + 1);

    const mine = new SeededRandom(seedForDate(DATE, SECRET)).pick(pool, 5);
    const theirs = new SeededRandom(seedForDate(DATE, OTHER)).pick(pool, 5);

    expect(mine).not.toEqual(theirs);
  });
});
