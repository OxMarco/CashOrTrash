/**
 * Names that must not become player handles.
 *
 * Impersonation risk rather than taste: a handle that reads as officialdom on
 * a public leaderboard, or that would collide with a route segment the day
 * handles appear in a URL. Vulgarity is a separate concern, handled by
 * `obscenity` in `UsernameService` rather than by a word list maintained here.
 *
 * This is a floor, not a content-moderation strategy — it stops the obvious
 * cases at claim time. Anything subtler is a reporting problem.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  // routes and system surfaces
  'admin',
  'administrator',
  'api',
  'auth',
  'root',
  'system',
  'support',
  'help',
  'moderator',
  'mod',
  'staff',
  'team',
  'official',
  'security',
  'billing',
  'login',
  'logout',
  'signup',
  'register',
  'settings',
  'me',
  'you',
  'null',
  'undefined',
  'anonymous',
  'deleted',
  'guest',
  // brand
  'cashortrash',
  'cashortrashapp',
  'cashortrashteam',
  'cashortrashofficial',
  'cashortrashsupport',
]);

/**
 * Slurs that `obscenity`'s English dataset does not carry, matched as
 * substrings of the separator-collapsed handle.
 *
 * Deliberately short. Anything the dataset already knows belongs there, where
 * it comes with the leetspeak and confusable handling this list has none of —
 * duplicating a word here only creates a second place to look when a rejection
 * surprises someone.
 */
export const ADDITIONAL_BLOCKED_SUBSTRINGS: readonly string[] = [
  'coon',
  'nigg',
  'paki',
  'spic',
];
