import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Pinned to the same images the local and production stacks run. A suite that proves
 * a partial unique index behaves correctly on Postgres 17 has proved nothing
 * if production runs 15.
 */
export const POSTGRES_IMAGE = 'postgres:17-alpine';
export const REDIS_IMAGE = 'redis:7-alpine';

export interface StartedStack {
  postgres: StartedPostgreSqlContainer;
  redis: StartedRedisContainer;
}

/**
 * Jest's globalSetup and globalTeardown run in the same process but not the
 * same module registry as the specs, so the handles ride on `globalThis`.
 */
const STACK_KEY = '__CASHORTRASH_TEST_STACK__';

export async function startStack(): Promise<StartedStack> {
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('cashortrash_test')
      .withUsername('cashortrash')
      .withPassword('cashortrash')
      .start(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);

  const stack: StartedStack = { postgres, redis };
  (globalThis as Record<string, unknown>)[STACK_KEY] = stack;
  return stack;
}

export function getStack(): StartedStack | undefined {
  return (globalThis as Record<string, unknown>)[STACK_KEY] as
    StartedStack | undefined;
}

export async function stopStack(): Promise<void> {
  const stack = getStack();
  if (!stack) return;

  await Promise.all([stack.postgres.stop(), stack.redis.stop()]);
  delete (globalThis as Record<string, unknown>)[STACK_KEY];
}

/**
 * The env the application will boot against. Written into `process.env` before
 * any Nest module is imported: `@nestjs/config` treats an already-set variable
 * as authoritative, so this wins over the developer's `.env` and the suite
 * never touches their local database.
 */
export function applyEnv(stack: StartedStack): void {
  const env: Record<string, string> = {
    NODE_ENV: 'test',
    PORT: '0',
    API_PREFIX: 'v1',
    LOG_LEVEL: 'silent',
    SWAGGER_ENABLED: 'false',

    DATABASE_HOST: stack.postgres.getHost(),
    DATABASE_PORT: String(stack.postgres.getPort()),
    DATABASE_USER: stack.postgres.getUsername(),
    DATABASE_PASSWORD: stack.postgres.getPassword(),
    DATABASE_NAME: stack.postgres.getDatabase(),
    DATABASE_SSL: 'false',

    REDIS_HOST: stack.redis.getHost(),
    REDIS_PORT: String(stack.redis.getPort()),
    REDIS_PASSWORD: '',
    REDIS_DB: '0',

    JWT_ACCESS_SECRET: 'test-access-secret-at-least-sixteen-chars',
    JWT_ACCESS_TTL: '15m',

    ROUNDS_PER_SESSION: '5',
    // The dwell floor ships on at a second. Off here, because every spec bets
    // the instant the round is dealt and none of them are about that; the two
    // that are raise it themselves through the mutable `app` config.
    MIN_ROUND_SECONDS: '0',

    DAILY_SEED_SECRET: 'test-daily-seed-secret-at-least-thirty-two-chars',
    // One day, not the production seven. The fixture catalogue is 24 items, and
    // a week of lookahead would reserve 40 of them — every draw would fall
    // through to the reserve and the exclusions would prove nothing.
    DAILY_PREGENERATE_DAYS: '1',
    ITEM_COOLDOWN_DAYS: '30',

    // The suite fires hundreds of requests from one address in seconds. Rate
    // limiting is exercised deliberately in its own spec, not incidentally in
    // every other one.
    THROTTLE_TTL_MS: '60000',
    THROTTLE_LIMIT: '100000',
    QUICK_SESSIONS_PER_HOUR: '100000',
    ACCOUNTS_PER_IP_PER_DAY: '100000',

    DEEP_LINK_BASE: 'cashortrash://match',

    // No suite may reach OpenAI, whatever is in the developer's `.env`.
    // Set explicitly rather than left unset: `ConfigModule` loads `.env`, and
    // dotenv only declines to overwrite a variable that is *already present* —
    // so an empty string is what actually keeps a real key out of the suite.
    // `ItemCopywriter` reads that as "unavailable" and returns no copy.
    OPENAI_API_KEY: '',

    // Rates come from the fallback and never move. Left unset, the default
    // provider is the public Frankfurter API and `ExchangeRatesService` fires a
    // real fetch on every boot — so the suite depends on somebody else's
    // uptime, and a snapshot landing mid-spec moves the currency digest under
    // `manifest.e2e-spec`, which is asserting that it held still while only the
    // catalogue changed. Same rule as `OPENAI_API_KEY` above: no suite reaches
    // the network. Port 1 refuses instantly, so the fallback stands for the
    // whole run rather than after a timeout.
    CURRENCY_API_URL: 'http://127.0.0.1:1/no-rates-in-tests',
    CURRENCY_TIMEOUT_MS: '500',

    // A temp directory, never a path inside the repo: a spec that writes an
    // image would otherwise leave untracked files behind, and the default
    // (`/var/lib/cashortrash/media`) is not writable on a developer's machine.
    MEDIA_ROOT: join(tmpdir(), `cashortrash-media-${process.pid}`),
    MEDIA_PUBLIC_BASE: '',
  };

  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}
