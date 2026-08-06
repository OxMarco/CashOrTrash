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

  DATABASE_HOST: Joi.string().required(),
  DATABASE_PORT: Joi.number().port().default(5432),
  DATABASE_USER: Joi.string().required(),
  DATABASE_PASSWORD: Joi.string().allow('').required(),
  DATABASE_NAME: Joi.string().required(),
  DATABASE_SSL: Joi.boolean().default(false),
  // Opt *out* of entity-driven schema sync, in any environment. On by default
  // and honoured everywhere, because this project has no migrations: the
  // entities are the schema and the boot is what applies them. Turning it off
  // leaves a schema nothing then updates — and see `databaseConfig.synchronize`
  // for what leaving it on does to anything the entities do not describe.
  DATABASE_SYNCHRONIZE: Joi.boolean().default(true),

  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').default(''),
  REDIS_DB: Joi.number().min(0).default(0),

  JWT_ACCESS_SECRET: Joi.string().min(16).required(),
  // `<digits><s|m|h|d>` — the shape AuthService casts into jsonwebtoken's
  // expiresIn union and that ttlToSeconds parses.
  JWT_ACCESS_TTL: Joi.string()
    .pattern(/^\d+[smhd]$/)
    .default('15m'),
  JWT_REFRESH_SECRET: Joi.string()
    .min(16)
    .required()
    .invalid(Joi.ref('JWT_ACCESS_SECRET'))
    .messages({
      'any.invalid': 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET',
    }),
  JWT_REFRESH_TTL: Joi.string()
    .pattern(/^\d+[smhd]$/)
    .default('60d'),

  // Where the catalogue lives on disk. Empty is allowed and is the normal
  // case: the tree ships inside the image and is resolved relative to the
  // compiled output, so an operator should not have to know this exists.
  ITEMS_ROOT: Joi.string().allow('').default(''),
  // Whether a deploy imports the tree it shipped with.
  IMPORT_ON_BOOT: Joi.boolean().default(true),
  // Required as soon as the import can run, because the import is what writes
  // every title and description in the catalogue. Unset with the job enabled
  // would import a catalogue of raw filenames and only look wrong afterwards,
  // so it fails boot validation instead.
  // Empty is permitted only with the import switched off, where it means "no
  // copywriter" — the state the e2e suite runs in so no spec can reach OpenAI.
  // With the import on, `required()` refuses an empty string as well as a
  // missing one, which is the point: both would import raw filenames.
  OPENAI_API_KEY: Joi.string().when('IMPORT_ON_BOOT', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  OPENAI_MODEL: Joi.string().default('gpt-5.4'),

  ROUNDS_PER_SESSION: Joi.number().min(1).max(20).default(5),

  // The shot clock. 0 turns it off; the cap is generous because the value is a
  // product decision, not a safety one.
  ROUND_SECONDS: Joi.number().min(0).max(300).default(10),
  ROUND_GRACE_MS: Joi.number().min(0).max(10_000).default(1_500),
  // A dwell floor at or above the deadline would make every bet unplaceable:
  // too early to be accepted, too late to be scored. Refuse the combination at
  // boot rather than at the first bet of the day.
  MIN_ROUND_SECONDS: Joi.number()
    .min(0)
    .default(0)
    .when('ROUND_SECONDS', {
      is: Joi.number().greater(0),
      then: Joi.number().less(Joi.ref('ROUND_SECONDS')),
    }),

  THROTTLE_TTL_MS: Joi.number().min(1000).default(60_000),
  THROTTLE_LIMIT: Joi.number().min(1).default(120),

  DEEP_LINK_BASE: Joi.string().default('cashortrash://match'),
  SWAGGER_ENABLED: Joi.boolean().default(true),

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

  // The floor under a live rate, used only before the first fetch lands or
  // when the provider is unreachable with nothing cached. Bounded rather than
  // merely positive: a rate near zero collapses every slider to a single stop
  // and a huge one overflows the integer minor units the wire carries, and
  // both would surface as an unplayable round rather than as a bad config.
  CURRENCY_FALLBACK_RATE_EUR: Joi.number().min(0.01).max(1000).default(0.92),
  CURRENCY_FALLBACK_RATE_GBP: Joi.number().min(0.01).max(1000).default(0.79),
});
