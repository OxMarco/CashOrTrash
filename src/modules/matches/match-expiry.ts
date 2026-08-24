import { Match, MatchStatus } from './entities/match.entity';

const MS_PER_DAY = 86_400_000;

/**
 * Whether an invite has aged out, judged rather than read.
 *
 * The sweep flips rows to `expired` once a night, so between the deadline and
 * the next sweep a row still says `pending` while no longer being joinable.
 * That gap is what this closes: every path that lets someone *into* a match
 * asks this instead of trusting the column, which keeps the nightly job to
 * what it should be — hygiene — rather than making it load-bearing.
 *
 * Only `pending` is subject to it. An active match is two people playing at
 * their own pace, and days between their sessions is the mode working.
 */
export function inviteHasExpired(
  match: Pick<Match, 'status' | 'createdAt'>,
  ttlDays: number,
  now: Date = new Date(),
): boolean {
  if (match.status === MatchStatus.EXPIRED) return true;
  if (match.status !== MatchStatus.PENDING) return false;
  // 0 is the documented "never expires".
  if (ttlDays <= 0) return false;
  return now.getTime() - match.createdAt.getTime() > ttlDays * MS_PER_DAY;
}
