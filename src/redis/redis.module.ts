import { Global, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import KeyvRedis from '@keyv/redis';
import Redis, { RedisOptions } from 'ioredis';

import { RedisConfig } from 'src/config/configuration';
import { CACHE_STORE, REDIS_CLIENT, REDIS_SUBSCRIBER } from './redis.constants';

const baseRedisOptions = (cfg: RedisConfig): RedisOptions => ({
  host: cfg.host,
  port: cfg.port,
  password: cfg.password,
  db: cfg.db,
  enableReadyCheck: true,
  connectTimeout: 5_000,
  retryStrategy: (attempt) => Math.min(attempt * 100, 2_000),
});

/** Request-path commands reject promptly when Redis is unavailable. */
export const buildRedisOptions = (cfg: RedisConfig): RedisOptions => ({
  ...baseRedisOptions(cfg),
  maxRetriesPerRequest: 2,
  commandTimeout: 2_000,
});

/** BullMQ blocking commands require unbounded per-request retries. */
export const buildBullRedisOptions = (cfg: RedisConfig): RedisOptions => ({
  ...baseRedisOptions(cfg),
  maxRetriesPerRequest: null,
});

export const buildRedisUrl = (cfg: RedisConfig): string => {
  const auth = cfg.password ? `:${encodeURIComponent(cfg.password)}@` : '';
  return `redis://${auth}${cfg.host}:${cfg.port}/${cfg.db}`;
};

const clientFactory = (config: ConfigService): Redis => {
  const cfg = config.getOrThrow<RedisConfig>('redis');
  return new Redis(buildRedisOptions(cfg));
};

/**
 * One shared ioredis connection, re-exported app-wide. BullMQ, the throttler
 * storage, the cache and the socket.io adapter all hang off this (BullMQ and
 * the adapter open their own, since blocking commands and pub/sub cannot share
 * a connection that also serves ordinary traffic).
 *
 * Every connection the application opens is created here so that exactly one
 * place is responsible for closing them. A connection created anonymously
 * inside another module's `useFactory` is one Nest never sees, and one the
 * process then waits on forever at shutdown.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: clientFactory,
    },
    {
      provide: REDIS_SUBSCRIBER,
      inject: [ConfigService],
      useFactory: clientFactory,
    },
    {
      provide: CACHE_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new KeyvRedis(buildRedisUrl(config.getOrThrow<RedisConfig>('redis')), {
          connectionTimeout: 2_000,
          // Catalogue cache failures degrade to a database read.
          throwOnConnectError: false,
          throwOnErrors: false,
        }),
    },
  ],
  exports: [REDIS_CLIENT, REDIS_SUBSCRIBER, CACHE_STORE],
})
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  async onApplicationShutdown(): Promise<void> {
    for (const token of [REDIS_CLIENT, REDIS_SUBSCRIBER]) {
      const client = this.moduleRef.get<Redis>(token, { strict: false });
      if (client && client.status !== 'end') {
        await client.quit().catch((err: Error) => {
          this.logger.warn(`Redis shutdown: ${err.message}`);
        });
      }
    }

    const cacheStore = this.moduleRef.get<KeyvRedis<unknown>>(CACHE_STORE, {
      strict: false,
    });
    await cacheStore?.disconnect().catch((err: Error) => {
      this.logger.warn(`Cache store shutdown: ${err.message}`);
    });
  }
}
