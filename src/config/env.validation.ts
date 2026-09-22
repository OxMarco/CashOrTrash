import * as Joi from 'joi';

/**
 * Boot-time env contract. Anything missing or malformed fails the process
 * immediately rather than surfacing as a null-pointer three requests later.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  API_PREFIX: Joi.string().default('v1'),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),

  DATABASE_HOST: Joi.string().default('localhost'),
  DATABASE_PORT: Joi.number().port().default(5432),
  DATABASE_USER: Joi.string().default('cashortrash'),
  DATABASE_PASSWORD: Joi.string().allow('').default('cashortrash'),
  DATABASE_NAME: Joi.string().default('cashortrash'),
  DATABASE_SSL: Joi.boolean().default(false),
  // Pool sizing and the two timeouts that keep a stuck database from taking
  // every request down with it — see `databaseConfig`. 0 disables either
  // timeout, which `pg` and Postgres both read as "no limit".
  DATABASE_POOL_MAX: Joi.number().integer().min(1).max(200).default(10),
  DATABASE_CONNECTION_TIMEOUT_MS: Joi.number()
    .integer()
    .min(0)
    .max(120_000)
    .default(5_000),
  DATABASE_STATEMENT_TIMEOUT_MS: Joi.number()
    .integer()
    .min(0)
    .max(3_600_000)
    .default(15_000),
  // Schema changes are migrations in every environment. Refuse the old switch
  // explicitly so a stale deployment file cannot silently turn destructive
  // entity synchronization back on.
  DATABASE_SYNCHRONIZE: Joi.forbidden(),

  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').default(''),
  REDIS_DB: Joi.number().min(0).default(0),

  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  // `<digits><s|m|h|d>` — the shape AuthService casts into jsonwebtoken's
  // expiresIn union and that ttlToSeconds parses.
  JWT_ACCESS_TTL: Joi.string()
    .pattern(/^\d+[smhd]$/)
    .default('15m'),
  // Required in production, because the model is what writes every title and
  // description a player reads. Without it the portal still accepts uploads and
  // the catalogue still plays — items simply keep the text that was typed into
  // the form — but shipping that to a store is not the intent, so it fails boot
  // validation rather than degrading quietly.
  //
  // Empty is permitted everywhere else, which is the state the e2e suite runs
  // in so that no spec can reach OpenAI.
  OPENAI_API_KEY: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  OPENAI_MODEL: Joi.string().default('gpt-5.4'),
  // Two minutes is generous for a batch of four items and far short of the
  // SDK's ten-minute default, which is long enough to hold the copy pass's
  // advisory lock across a whole maintenance window. Capped at the default the
  // bound exists to replace.
  OPENAI_TIMEOUT_MS: Joi.number().min(1_000).max(600_000).default(120_000),
  OPENAI_MAX_RETRIES: Joi.number().integer().min(0).max(5).default(2),

  // --- admin portal ---------------------------------------------------------
  // An scrypt hash as `<salt-hex>:<key-hex>`; `npm run admin:hash` prints one.
  // Required in production because the catalogue cannot be filled without the
  // portal, and a deployment with no way to add items is a broken one.
  //
  // The pattern is checked rather than merely the presence of a string: the
  // likeliest mistake is pasting the password itself here, which would store a
  // plaintext credential and reject every login — a failure that looks like a
  // forgotten password rather than a misconfiguration.
  ADMIN_PASSWORD_HASH: Joi.string()
    .pattern(/^[0-9a-f]{32}:[0-9a-f]{128}$/)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.string().allow('').optional(),
    }),
  // Independent of JWT_ACCESS_SECRET on purpose — see AdminJwtStrategy. Long
  // enough that it cannot be a memorable phrase someone reused.
  ADMIN_JWT_SECRET: Joi.string()
    .min(32)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.string().allow('').optional(),
    }),
  ADMIN_SESSION_TTL: Joi.string()
    .pattern(/^\d+[smhd]$/)
    .default('2h'),

  ROUNDS_PER_SESSION: Joi.number().min(1).max(20).default(5),

  // The shot clock. 0 turns it off; the cap is generous because the value is a
  // product decision, not a safety one.
  ROUND_SECONDS: Joi.number().min(0).max(300).default(10),
  ROUND_GRACE_MS: Joi.number().min(0).max(10_000).default(1_500),
  SLIDER_SEED_SECRET: Joi.string()
    .min(32)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.string().default(
        'development-slider-seed-secret-change-me',
      ),
    }),
  // Keys the daily draw. Same contract as SLIDER_SEED_SECRET above, and for the
  // same reason — see `seedForDate`. A production boot without it fails rather
  // than quietly dealing a challenge anyone can compute a week ahead.
  DAILY_SEED_SECRET: Joi.string()
    .min(32)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.string().default(
        'development-daily-seed-secret-change-me',
      ),
    }),
  // Also the depth of the reserve held out of quick and h2h draws, so it cannot
  // sensibly run to the length of the catalogue.
  DAILY_PREGENERATE_DAYS: Joi.number().integer().min(1).max(30).default(1),
  ITEM_COOLDOWN_DAYS: Joi.number().integer().min(0).max(365).default(30),
  // A year is the ceiling because a bound that long is not a bound; 0 is the
  // explicit "never expires", which should be chosen rather than defaulted to.
  MATCH_INVITE_TTL_DAYS: Joi.number().integer().min(0).max(365).default(7),
  QUICK_SESSIONS_PER_HOUR: Joi.number().integer().min(0).default(30),
  ACCOUNTS_PER_IP_PER_DAY: Joi.number().integer().min(0).default(50),
  // The freemium line — see `billingConfig`. 0 lifts it for everyone.
  FREE_QUICK_ROUNDS_PER_DAY: Joi.number().integer().min(0).default(5),
  // Required in production: without the key nothing a player bought could be
  // confirmed, and without the webhook secret a renewal or refund would never
  // reach the server — a paying player would be held to the free limit.
  REVENUECAT_SECRET_API_KEY: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.string().pattern(/^sk_/).required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  REVENUECAT_WEBHOOK_AUTH: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(32).required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  REVENUECAT_API_URL: Joi.string()
    .uri()
    .default('https://api.revenuecat.com/v1'),
  REVENUECAT_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1_000)
    .max(60_000)
    .default(10_000),
  REVENUECAT_ENTITLEMENT_ID: Joi.string().default('premium'),
  // Capped at a year: `registrationIp` is retained network metadata, and a
  // retention window longer than that is not a window.
  REGISTRATION_IP_RETENTION_DAYS: Joi.number()
    .integer()
    .min(0)
    .max(365)
    .default(30),
  LEADERBOARD_MIN_ACCOUNT_AGE_HOURS: Joi.number()
    .integer()
    .min(0)
    .max(720)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.number().default(24),
      otherwise: Joi.number().default(0),
    }),
  // A dwell floor at or above the deadline would make every bet unplaceable:
  // too early to be accepted, too late to be scored. Refuse the combination at
  // boot rather than at the first bet of the day.
  //
  // On by default at one second. No honest player reads an object, forms a
  // price and drags two thumbs inside that — the floor costs a human nothing
  // and costs a script the only thing it has, which is speed. Set 0 to disable.
  MIN_ROUND_SECONDS: Joi.number()
    .min(0)
    .default(1)
    .when('ROUND_SECONDS', {
      is: Joi.number().greater(0),
      then: Joi.number().less(Joi.ref('ROUND_SECONDS')),
    }),

  THROTTLE_TTL_MS: Joi.number().min(1000).default(60_000),
  THROTTLE_LIMIT: Joi.number().min(1).default(120),

  PUSH_PROVIDER: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().valid('expo').default('expo'),
    otherwise: Joi.string().valid('expo', 'logging').default('logging'),
  }),
  PUSH_TIMEOUT_MS: Joi.number().min(1_000).max(60_000).default(10_000),

  DEEP_LINK_BASE: Joi.string().default('cashortrash://match'),
  // https only, and empty is allowed: a shared result drops its link rather
  // than carrying one a reader cannot open. An http origin would be worse than
  // no link at all, so the scheme is pinned rather than merely suggested.
  PUBLIC_ORIGIN: Joi.string()
    .uri({ scheme: ['https'] })
    .allow('')
    .default(''),
  SWAGGER_ENABLED: Joi.boolean().default(true),
  SUPPORT_EMAIL: Joi.string()
    .email()
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.string().default('support@example.com'),
    }),
  // Universal/App Link association. Optional until the app is published:
  // while either is empty the matching `.well-known` file answers 404 and a
  // shared /match link opens in the browser instead of the app. Validated
  // when set so a typo cannot ship as a silently-broken association file.
  APPLE_APP_ID: Joi.string()
    .pattern(/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/)
    .allow('')
    .default(''),
  ANDROID_APP_PACKAGE: Joi.string()
    .pattern(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/)
    .default('fun.cashortrash.app'),
  ANDROID_SHA256_CERT_FINGERPRINT: Joi.string()
    .pattern(/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/)
    .allow('')
    .default(''),

  // Browser origins for the app's web target, comma-separated. Only consulted
  // in production — development allows any origin, and native apps never
  // preflight. Empty means the API has no browser clients.
  CORS_ORIGINS: Joi.string().allow('').default(''),

  // Defaulted rather than required: a fresh checkout must boot without an
  // operator having to know this exists, and an item catalogue with no photos
  // never reads from it. Production sets it to the mounted volume.
  MEDIA_ROOT: Joi.string().default('/var/lib/cashortrash/media'),
  // Absolute origin with no trailing slash, or empty for same-origin.
  MEDIA_PUBLIC_BASE: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .default(''),

  // Live exchange rates, base USD. Defaults to the ECB's daily reference rates
  // via Frankfurter, which needs no key.
  CURRENCY_API_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('https://api.frankfurter.dev/v1/latest'),
  // An hour: reference rates move once a day, and a shorter cycle only widens
  // the window in which a round is dealt on one rate and bet on another.
  CURRENCY_REFRESH_SECONDS: Joi.number().min(60).default(3_600),
  CURRENCY_TIMEOUT_MS: Joi.number().min(500).default(5_000),
});
