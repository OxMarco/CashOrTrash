import { registerAs } from '@nestjs/config';

const bool = (v: string | undefined, fallback = false): boolean =>
  v === undefined ? fallback : v === 'true' || v === '1';

const int = (v: string | undefined, fallback: number): number =>
  v === undefined || v === '' ? fallback : Number.parseInt(v, 10);

export const appConfig = registerAs('app', () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: int(process.env.PORT, 3000),
  apiPrefix: process.env.API_PREFIX ?? 'v1',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  swaggerEnabled: bool(process.env.SWAGGER_ENABLED, true),
  deepLinkBase: process.env.DEEP_LINK_BASE ?? 'cashortrash://match',
  /**
   * The public https origin this deployment answers on, used to give a shared
   * result somewhere to point.
   *
   * Deliberately not `deepLinkBase`: that is a custom scheme, which is right
   * for an invite passed between two people who both have the app, and useless
   * in a post — no browser resolves `cashortrash://`, so a link built from it
   * dies for every reader who has not installed the game yet. Empty by default,
   * and an empty value omits the line rather than shipping a broken URL.
   */
  publicOrigin: (process.env.PUBLIC_ORIGIN ?? '').replace(/\/+$/, ''),
  roundsPerSession: int(process.env.ROUNDS_PER_SESSION, 5),
  minRoundSeconds: int(process.env.MIN_ROUND_SECONDS, 0),
  /**
   * How long a player has to bet, from the moment the round is dealt. The clock
   * is the server's — it starts when `/current` stamps the row and is checked
   * against the server's own time when the bet lands — so a client that lies
   * about its clock, pauses its timer, or never runs one at all is measured the
   * same as everyone else. 0 removes the limit.
   */
  roundSeconds: int(process.env.ROUND_SECONDS, 10),
  /**
   * Slack on that deadline, to cover the flight of a bet placed in time. Ten
   * seconds is short enough that a round trip is a real fraction of it, and a
   * player who tapped at 0.2s remaining should not lose the round to their own
   * latency. Cheating with it buys a fixed, tiny amount of extra thinking time
   * and cannot be repeated or accumulated.
   */
  roundGraceMs: int(process.env.ROUND_GRACE_MS, 1_500),
  // Keyed randomness keeps the slider layout reproducible inside a challenge
  // or match without making it reproducible by the player. Every identifier in
  // the unkeyed scope is sent to the client, so a plain hash would let someone
  // enumerate prices until the returned bounds matched.
  sliderSeedSecret:
    process.env.SLIDER_SEED_SECRET ??
    'development-slider-seed-secret-change-me',
  // The same argument one line up, applied to *which* items a day deals rather
  // than the scale they are priced on. Its own key, not a reuse of the slider's:
  // the slider secret sits under a live oracle — every finished round hands a
  // player both the bounds and the answer they were drawn around — and this one
  // sits under none. Sharing would extend that exposure to the draw, and would
  // make rotating either secret reshuffle both.
  dailySeedSecret:
    process.env.DAILY_SEED_SECRET ?? 'development-daily-seed-secret-change-me',
  /**
   * How far ahead the daily generator runs — and therefore how long an item is
   * held out of quick and head-to-head draws before it is dealt as a daily.
   *
   * The two are the same number by construction: `CatalogService` reserves
   * every item belonging to a `daily_challenge` row dated today or later, so
   * the reserve reaches exactly as far as the generator has. One day of
   * lookahead leaves an item dealt in a quick round today free to turn up in
   * Thursday's daily, with its price already known.
   */
  dailyPregenerateDays: int(process.env.DAILY_PREGENERATE_DAYS, 1),
  /**
   * How long an item stays out of one player's quick and head-to-head draws
   * after they have been dealt it.
   *
   * A player who has seen an object already knows its price, so re-dealing it
   * inside the window is a free round rather than a guess. Not permanent: the
   * catalogue is finite, and a heavy player would otherwise run it dry and be
   * left with nothing to play. 0 disables the exclusion entirely.
   */
  itemCooldownDays: int(process.env.ITEM_COOLDOWN_DAYS, 30),
  /**
   * How long an unanswered invite stays joinable.
   *
   * A pending match had no bound at all: the code kept working, so a friend
   * who never opened the link left a live entry point into a scored match
   * against the host indefinitely. Bounding it is mostly about that — the
   * host cannot revoke a code they no longer have, because the invite lives
   * on their device and a second one overwrites it.
   *
   * Only `pending` ages out. Once someone has joined, the two players are
   * expected to play at different times — days apart is the mode working, not
   * a match going stale. 0 disables expiry and restores the old behaviour.
   */
  matchInviteTtlDays: int(process.env.MATCH_INVITE_TTL_DAYS, 7),
  /**
   * The ceiling on quick rounds one account can start in an hour.
   *
   * Every reveal is an answer, so an unmetered quick round is a catalogue
   * dump waiting for a script. This does not make harvesting impossible — the
   * cooldown above expires, and patience defeats a rate limit — it makes it
   * slow enough to be worth someone's attention. 0 turns it off.
   */
  quickSessionsPerHour: int(process.env.QUICK_SESSIONS_PER_HOUR, 30),
  /**
   * New accounts one address may mint in a UTC day.
   *
   * `POST /auth/anonymous` is already capped per minute, which stops a burst
   * and nothing else: the leaderboard's defence against a fresh account is a
   * 24-hour age gate, and a farm that registers slowly simply waits it out.
   * This is the budget over the window that gate actually cares about. Only
   * *creations* spend it — a returning device is free. 0 turns it off.
   */
  accountsPerIpPerDay: int(process.env.ACCOUNTS_PER_IP_PER_DAY, 50),
  /**
   * How long `user.registrationIp` is kept before a nightly job clears it.
   *
   * The address is the only retained network identifier, and it is stored for
   * exactly one question: "did these accounts all come from one
   * place?". That question is asked about recent registrations — a farm is
   * found in days, not years — so anything past this window is being kept for
   * no purpose, which is the part that makes it a liability rather than a
   * control. 0 disables the pruning and keeps addresses for the life of the
   * account, which should be a deliberate choice and not a default.
   */
  registrationIpRetentionDays: int(
    process.env.REGISTRATION_IP_RETENTION_DAYS,
    30,
  ),
  leaderboardMinAccountAgeHours: int(
    process.env.LEADERBOARD_MIN_ACCOUNT_AGE_HOURS,
    (process.env.NODE_ENV ?? 'development') === 'production' ? 24 : 0,
  ),
  // Browser origins allowed to call the API — the mobile app's web target.
  // Native builds never preflight, so this list concerns the browser alone.
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
}));

export const databaseConfig = registerAs('database', () => ({
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: int(process.env.DATABASE_PORT, 5432),
  username: process.env.DATABASE_USER ?? 'cashortrash',
  password: process.env.DATABASE_PASSWORD ?? 'cashortrash',
  database: process.env.DATABASE_NAME ?? 'cashortrash',
  ssl: bool(process.env.DATABASE_SSL, false),
  /**
   * Local development can reconcile entities automatically for fast iteration.
   * There is no migration chain behind this any more — it was removed while the
   * project is pre-launch, on the grounds that a schema nobody has shipped has
   * nothing to migrate *from*, and keeping a chain honest costs a migration per
   * entity change for no benefit yet.
   *
   * The cost is real and worth writing down rather than discovering: synchronize
   * reconciles the database to the entities and will drop a column, an index or
   * a constraint it cannot account for, taking the data with it. That is
   * survivable against a database that can be rebuilt and is not survivable
   * against one with users in it. Anything synchronize cannot express lives in
   * `SchemaExtras`, which reapplies it on every boot.
   *
   * Before the first real deploy this wants reversing: an initial migration
   * generated from the entities, `migrationsRun` restored, and production
   * pinned back to `false`.
   */
  synchronize: bool(process.env.DATABASE_SYNCHRONIZE, true),
}));

export const redisConfig = registerAs('redis', () => ({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: int(process.env.REDIS_PORT, 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  db: int(process.env.REDIS_DB, 0),
}));

export const authConfig = registerAs('auth', () => ({
  accessSecret: process.env.JWT_ACCESS_SECRET as string,
  accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
}));

export const copywritingConfig = registerAs('copywriting', () => ({
  // The model rewrites the title and the description from the name the admin
  // portal was given. It is never shown the price; see ItemCopywriter for why
  // that matters.
  openaiApiKey: process.env.OPENAI_API_KEY || undefined,
  openaiModel: process.env.OPENAI_MODEL ?? 'gpt-5.4',
}));

export const adminConfig = registerAs('admin', () => ({
  /**
   * An scrypt hash of the portal password, as `<salt-hex>:<key-hex>`.
   *
   * A hash rather than the password itself so the deployed environment — which
   * is read by `docker compose config`, printed by a misconfigured log line and
   * visible to anyone who can exec into the container — never holds the thing
   * that grants access. `npm run admin:hash` prints one.
   *
   * Empty disables the portal outright, which is the right default: a fresh
   * checkout should not expose an admin surface, and production refuses to boot
   * without a real value rather than falling back to one.
   */
  passwordHash: process.env.ADMIN_PASSWORD_HASH || '',
  /**
   * Independent of `JWT_ACCESS_SECRET` on purpose. A player token and an admin
   * token must not be forgeable from the same key — sharing it would make every
   * device that ever authenticated a potential catalogue editor.
   */
  jwtSecret: process.env.ADMIN_JWT_SECRET || '',
  sessionTtl: process.env.ADMIN_SESSION_TTL ?? '2h',
}));

export const throttleConfig = registerAs('throttle', () => ({
  ttlMs: int(process.env.THROTTLE_TTL_MS, 60_000),
  limit: int(process.env.THROTTLE_LIMIT, 120),
}));

export const pushConfig = registerAs('push', () => ({
  provider:
    process.env.PUSH_PROVIDER ??
    ((process.env.NODE_ENV ?? 'development') === 'production'
      ? 'expo'
      : 'logging'),
  timeoutMs: int(process.env.PUSH_TIMEOUT_MS, 10_000),
}));

export const mediaConfig = registerAs('media', () => ({
  // Where item derivatives are written. A named volume in production, a
  // temp directory under test — never a path inside the repo, which a stray
  // spec would then leave behind as untracked files.
  root: process.env.MEDIA_ROOT ?? '/var/lib/cashortrash/media',
  // Empty means same-origin: `photoUrl` stays a root-relative path and the API
  // serves the bytes itself. Set this to a CDN origin to move the traffic off
  // the app without rewriting a single stored row.
  publicBase: process.env.MEDIA_PUBLIC_BASE || undefined,
}));

export const legalConfig = registerAs('legal', () => ({
  supportEmail: process.env.SUPPORT_EMAIL ?? 'support@example.com',
}));

export const linksConfig = registerAs('links', () => ({
  // Null until the app exists in the stores; the association files are not
  // served until then.
  appleAppId: process.env.APPLE_APP_ID || null,
  androidPackage: process.env.ANDROID_APP_PACKAGE || 'fun.cashortrash.app',
  androidSha256Fingerprint: process.env.ANDROID_SHA256_CERT_FINGERPRINT || null,
}));

export const currencyConfig = registerAs('currency', () => ({
  // Rates are fetched live. The default is Frankfurter, which publishes the
  // ECB's daily reference rates with no key and no quota; any provider
  // answering `?base=&symbols=` with `{ rates: { EUR: 0.86, ... } }` will do.
  apiUrl:
    process.env.CURRENCY_API_URL ?? 'https://api.frankfurter.dev/v1/latest',
  refreshSeconds: int(process.env.CURRENCY_REFRESH_SECONDS, 3_600),
  timeoutMs: int(process.env.CURRENCY_TIMEOUT_MS, 5_000),
  // Not a rate — the floor under one. Used only until the first live fetch
  // lands, and again if the provider is unreachable with nothing cached. A
  // game that stops being playable because a third party is down is a worse
  // failure than one priced a few percent off for a few minutes.
  fallbackRates: { EUR: 0.92, GBP: 0.79 },
}));

export const configurations = [
  appConfig,
  databaseConfig,
  redisConfig,
  authConfig,
  copywritingConfig,
  adminConfig,
  throttleConfig,
  pushConfig,
  mediaConfig,
  legalConfig,
  linksConfig,
  currencyConfig,
];

export type AppConfig = ReturnType<typeof appConfig>;
export type DatabaseConfig = ReturnType<typeof databaseConfig>;
export type RedisConfig = ReturnType<typeof redisConfig>;
export type AuthConfig = ReturnType<typeof authConfig>;
export type CopywritingConfig = ReturnType<typeof copywritingConfig>;
export type AdminConfig = ReturnType<typeof adminConfig>;
export type ThrottleConfig = ReturnType<typeof throttleConfig>;
export type PushConfig = ReturnType<typeof pushConfig>;
export type MediaConfig = ReturnType<typeof mediaConfig>;
export type LegalConfig = ReturnType<typeof legalConfig>;
export type LinksConfig = ReturnType<typeof linksConfig>;
export type CurrencyConfig = ReturnType<typeof currencyConfig>;
