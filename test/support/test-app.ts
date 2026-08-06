import { ConfigService } from '@nestjs/config';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { attachRealtime, configureApp } from '../../src/app.bootstrap';
import { AppModule } from '../../src/app.module';
import { AppConfig } from '../../src/config/configuration';
import { TRUST_PROXY_HOPS } from '../../src/config/proxy';
import { REDIS_CLIENT } from '../../src/redis/redis.constants';
import { Api } from './api-client';

export interface TestApp {
  app: NestFastifyApplication;
  baseUrl: string;
  dataSource: DataSource;
  redis: Redis;
  /** An unauthenticated client; call `.as(token)` for an authenticated one. */
  api: Api;
  close(): Promise<void>;
}

/**
 * Boots a real replica: real Fastify listener, real Postgres, real Redis, and
 * — critically — the same `configureApp` production uses. Nothing here is a
 * mock, because the behaviours these suites exist to prove (a partial unique
 * index, a pessimistic lock, a Redis-backed socket room) live below the layer
 * a mock would replace.
 *
 * The listener is a real one on a real port, rather than an in-process handle,
 * because the head-to-head suite runs two replicas at once and connects socket
 * clients to both.
 */
export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({
      trustProxy: TRUST_PROXY_HOPS,
      bodyLimit: 256 * 1024,
    }),
    { logger: false },
  );

  const appConfig = app.get(ConfigService).getOrThrow<AppConfig>('app');
  await configureApp(app, appConfig);
  await attachRealtime(app);

  // Port 0: every replica in a suite gets its own, so two can run side by side.
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();

  const dataSource = app.get(DataSource);
  const redis = app.get<Redis>(REDIS_CLIENT);

  return {
    app,
    baseUrl,
    dataSource,
    redis,
    api: new Api(baseUrl),
    close: () => app.close(),
  };
}

/**
 * Tables that hold play, as opposed to catalogue. The catalogue is seeded once
 * in globalSetup and left alone — reseeding between specs would renumber
 * `item.id`, and the daily challenge is a deterministic draw over those ids.
 */
const GAMEPLAY_TABLES = [
  'session_round',
  'game_session',
  'daily_score',
  'friendship',
  'push_token',
  'match',
  'daily_challenge',
  'theme_stat',
  '"user"',
];

/**
 * Between specs, not between assertions: several suites deliberately build up
 * state across their own cases (play a daily, then read the leaderboard).
 */
export async function resetGameplayState(ctx: {
  dataSource: DataSource;
  redis: Redis;
}): Promise<void> {
  await ctx.dataSource.query(
    `TRUNCATE ${GAMEPLAY_TABLES.join(', ')} RESTART IDENTITY CASCADE`,
  );

  // Not FLUSHDB: BullMQ's job schedulers are registered once, at boot, and
  // flushing would delete them — leaving the app in a state no real replica is
  // ever in, and quietly breaking any test that asks what is scheduled.
  const keys = await ctx.redis.keys('*');
  const doomed = keys.filter((key) => !key.startsWith('bull:'));
  if (doomed.length) await ctx.redis.del(...doomed);
}
