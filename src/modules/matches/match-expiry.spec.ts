import { MatchStatus } from './entities/match.entity';
import { inviteHasExpired } from './match-expiry';

const NOW = new Date('2026-08-23T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

const match = (status: MatchStatus, createdAt: Date) => ({ status, createdAt });

describe('inviteHasExpired', () => {
  it('leaves an invite alone inside the window', () => {
    expect(
      inviteHasExpired(match(MatchStatus.PENDING, daysAgo(6)), 7, NOW),
    ).toBe(false);
  });

  it('expires one past it', () => {
    expect(
      inviteHasExpired(match(MatchStatus.PENDING, daysAgo(8)), 7, NOW),
    ).toBe(true);
  });

  // The boundary is "older than", not "at least" — an invite created exactly
  // seven days ago has had seven days, which is what the TTL promised.
  it('gives the last day of the window in full', () => {
    expect(
      inviteHasExpired(match(MatchStatus.PENDING, daysAgo(7)), 7, NOW),
    ).toBe(false);
  });

  /**
   * The distinction the whole rule rests on. Two people playing a match at
   * their own pace is the mode working as designed — the reveal even says so —
   * so an age that kills an unanswered invite must not touch a live game.
   */
  it('never expires a match somebody has joined, however old', () => {
    expect(
      inviteHasExpired(match(MatchStatus.ACTIVE, daysAgo(400)), 7, NOW),
    ).toBe(false);
    expect(
      inviteHasExpired(match(MatchStatus.COMPLETE, daysAgo(400)), 7, NOW),
    ).toBe(false);
  });

  it('reads an already-expired row as expired whatever its age', () => {
    expect(
      inviteHasExpired(match(MatchStatus.EXPIRED, daysAgo(0)), 7, NOW),
    ).toBe(true);
  });

  it('treats a zero TTL as "never expires"', () => {
    expect(
      inviteHasExpired(match(MatchStatus.PENDING, daysAgo(400)), 0, NOW),
    ).toBe(false);
  });
});
