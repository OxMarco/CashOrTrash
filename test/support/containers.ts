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
    JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-sixteen-chars',
    JWT_REFRESH_TTL: '60d',

    ROUNDS_PER_SESSION: '5',
    MIN_ROUND_SECONDS: '0',

    // The suite fires hundreds of requests from one address in seconds. Rate
    // limiting is exercised deliberately in its own spec, not incidentally in
    // every other one.
    THROTTLE_TTL_MS: '60000',
    THROTTLE_LIMIT: '100000',

    DEEP_LINK_BASE: 'cashortrash://match',

    // The import does not run on boot. The e2e fixtures build their own items,
    // and a job racing them would make every catalogue assertion depend on
    // whatever happened to be in `items/`.
    IMPORT_ON_BOOT: 'false',
    // And no suite may reach OpenAI, whatever is in the developer's `.env`.
    // Set explicitly rather than left unset: `ConfigModule` loads `.env`, and
    // dotenv only declines to overwrite a variable that is *already present* —
    // so an empty string is what actually keeps a real key out of the suite.
    // `ItemCopywriter` reads that as "unavailable" and returns no copy, which
    // is the path `catalogue-import.e2e-spec.ts` asserts against.
    OPENAI_API_KEY: '',

    // A temp directory, never a path inside the repo: a spec that writes an
    // image would otherwise leave untracked files behind, and the default
    // (`/var/lib/cashortrash/media`) is not writable on a developer's machine.
    MEDIA_ROOT: join(tmpdir(), `cashortrash-media-${process.pid}`),
    MEDIA_PUBLIC_BASE: '',
  };

  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}
