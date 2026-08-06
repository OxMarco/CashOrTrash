import { registerAs } from '@nestjs/config';
import { join } from 'node:path';

const bool = (v: string | undefined, fallback = false): boolean =>
  v === undefined ? fallback : v === 'true' || v === '1';

const int = (v: string | undefined, fallback: number): number =>
  v === undefined || v === '' ? fallback : Number.parseInt(v, 10);

const float = (v: string | undefined, fallback: number): number =>
  v === undefined || v === '' ? fallback : Number.parseFloat(v);

export const appConfig = registerAs('app', () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: int(process.env.PORT, 3000),
  apiPrefix: process.env.API_PREFIX ?? 'v1',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  swaggerEnabled: bool(process.env.SWAGGER_ENABLED, true),
  deepLinkBase: process.env.DEEP_LINK_BASE ?? 'cashortrash://match',
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
   * The entities are the schema, in every environment. There are no migrations
   * in this project: adding a column is an edit to an entity, and the next boot
   * applies it.
   *
   * Know what that costs before turning it off or on. `synchronize` reconciles
   * the live schema to the entities in both directions — a column, table, or
   * index it cannot account for is something it *drops*, not something it
   * leaves alone. So anything the database holds that no entity describes will
   * not survive a deploy, and a boot against the wrong database is destructive
   * rather than merely wrong. `DATABASE_SYNCHRONIZE=false` stops it, at the
   * price of a schema nothing then updates.
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
  refreshSecret: process.env.JWT_REFRESH_SECRET as string,
  refreshTtl: process.env.JWT_REFRESH_TTL ?? '60d',
}));

export const importConfig = registerAs('import', () => ({
  /**
   * The catalogue, as files. One directory per category, one image per item,
   * named `<description>_<price in USD>.<ext>`.
   *
   * Resolved against the working directory rather than `__dirname`, which the
   * placeholder photo can get away with and this cannot. The compiled layout is
   * not the same in both places: the image builds from `src` alone and lands
   * `dist/config/…`, while a checkout also compiles `scripts/` and so lands
   * `dist/src/config/…` — one directory deeper. Any fixed number of `..` is
   * therefore wrong somewhere. The working directory is `/app` in the image and
   * the package root under npm, so it is `items/` in both.
   */
  itemsRoot: process.env.ITEMS_ROOT || join(process.cwd(), 'items'),
  /**
   * Whether a deploy imports the tree it shipped with.
   *
   * On by default because that is the whole delivery mechanism: adding items is
   * meant to be "drop files in, redeploy". Turn it off to boot a replica that
   * serves the catalogue without touching it — useful when debugging against a
   * production database you would rather not have a job writing to.
   */
  onBoot: bool(process.env.IMPORT_ON_BOOT, true),
  // The model rewrites the title and the description. It is never shown the
  // price; see ItemCopywriter for why that matters.
  openaiApiKey: process.env.OPENAI_API_KEY || undefined,
  openaiModel: process.env.OPENAI_MODEL ?? 'gpt-5.4',
}));

export const throttleConfig = registerAs('throttle', () => ({
  ttlMs: int(process.env.THROTTLE_TTL_MS, 60_000),
  limit: int(process.env.THROTTLE_LIMIT, 120),
}));

export const mediaConfig = registerAs('media', () => ({
  // Where washed item derivatives are written. A named volume in production, a
  // temp directory under test — never a path inside the repo, which a stray
  // spec would then leave behind as untracked files.
  root: process.env.MEDIA_ROOT ?? '/var/lib/cashortrash/media',
  // Empty means same-origin: `photoUrl` stays a root-relative path and the API
  // serves the bytes itself. Set this to a CDN origin to move the traffic off
  // the app without rewriting a single stored row.
  publicBase: process.env.MEDIA_PUBLIC_BASE || undefined,
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
  fallbackRates: {
    EUR: float(process.env.CURRENCY_FALLBACK_RATE_EUR, 0.92),
    GBP: float(process.env.CURRENCY_FALLBACK_RATE_GBP, 0.79),
  },
}));

export const configurations = [
  appConfig,
  databaseConfig,
  redisConfig,
  authConfig,
  importConfig,
  throttleConfig,
  mediaConfig,
  currencyConfig,
];

export type AppConfig = ReturnType<typeof appConfig>;
export type DatabaseConfig = ReturnType<typeof databaseConfig>;
export type RedisConfig = ReturnType<typeof redisConfig>;
export type AuthConfig = ReturnType<typeof authConfig>;
export type ImportConfig = ReturnType<typeof importConfig>;
export type ThrottleConfig = ReturnType<typeof throttleConfig>;
export type MediaConfig = ReturnType<typeof mediaConfig>;
export type CurrencyConfig = ReturnType<typeof currencyConfig>;
