const MS_PER_DAY = 86_400_000;

/**
 * Challenge identity is UTC everywhere — "same items for everyone" only holds
 * if every replica agrees on which day it is. The client renders its countdown
 * from a server-supplied `resetsAt` instant rather than its own midnight.
 */
export const todayUtc = (now: Date = new Date()): string => toDateKey(now);

export const toDateKey = (date: Date): string =>
  date.toISOString().slice(0, 10);

export const fromDateKey = (key: string): Date =>
  new Date(`${key}T00:00:00.000Z`);

export const addDays = (key: string, days: number): string =>
  toDateKey(new Date(fromDateKey(key).getTime() + days * MS_PER_DAY));

export const daysBetween = (from: string, to: string): number =>
  Math.round(
    (fromDateKey(to).getTime() - fromDateKey(from).getTime()) / MS_PER_DAY,
  );

/** The instant the daily challenge rolls over — next UTC midnight. */
export const nextUtcMidnight = (now: Date = new Date()): Date =>
  new Date(fromDateKey(toDateKey(now)).getTime() + MS_PER_DAY);

export const secondsUntilReset = (now: Date = new Date()): number =>
  Math.max(
    0,
    Math.floor((nextUtcMidnight(now).getTime() - now.getTime()) / 1000),
  );

/**
 * ISO-8601 week key, `2026-W31`. Weeks start Monday, which is what the
 * "This week" leaderboard segment means to a player.
 */
export const isoWeekKey = (date: Date = new Date()): string => {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // Shift to the Thursday of this week; the year of that Thursday owns the week.
  const dayNumber = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNumber + 3);
  const isoYear = d.getUTCFullYear();

  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);

  const week =
    1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));

  return `${isoYear}-W${String(week).padStart(2, '0')}`;
};

/** The seven date keys making up the ISO week containing `date`. */
export const isoWeekDates = (date: Date = new Date()): string[] => {
  const dayNumber = (date.getUTCDay() + 6) % 7;
  const monday = new Date(
    fromDateKey(toDateKey(date)).getTime() - dayNumber * MS_PER_DAY,
  );
  return Array.from({ length: 7 }, (_, i) =>
    toDateKey(new Date(monday.getTime() + i * MS_PER_DAY)),
  );
};
