import { BullModule } from '@nestjs/bullmq';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { TypeOrmModule } from '@nestjs/typeorm';
import KeyvRedis from '@keyv/redis';
import Redis from 'ioredis';
import { LoggerModule } from 'nestjs-pino';

import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { UserThrottlerGuard } from './common/guards/user-throttler.guard';
import {
  AppConfig,
  configurations,
  DatabaseConfig,
  RedisConfig,
  ThrottleConfig,
} from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { SchemaExtras } from './database/schema-extras';
import { HealthModule } from './health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CurrencyModule } from './modules/currency/currency.module';
import { DailyModule } from './modules/daily/daily.module';
import { FriendsModule } from './modules/friends/friends.module';
import { HomeModule } from './modules/home/home.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { AdminModule } from './modules/admin/admin.module';
import { LandingModule } from './modules/landing/landing.module';
import { LeaderboardModule } from './modules/leaderboard/leaderboard.module';
import { ManifestModule } from './modules/manifest/manifest.module';
import { MatchesModule } from './modules/matches/matches.module';
import { MediaModule } from './modules/media/media.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ScoringModule } from './modules/scoring/scoring.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { UsersModule } from './modules/users/users.module';
import { CACHE_STORE, REDIS_CLIENT } from './redis/redis.constants';
import { buildBullRedisOptions, RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: configurations,
      validationSchema: envValidationSchema,
      // Boot fails on a bad env rather than surfacing three requests later.
      validationOptions: { abortEarly: false },
      cache: true,
    }),

    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const app = config.getOrThrow<AppConfig>('app');
        return {
          pinoHttp: {
            level: app.logLevel,
            transport:
              app.env === 'development' ? { target: 'pino-pretty' } : undefined,
            // Never log a bearer token or a device id.
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers.x-forwarded-for',
              'req.headers.x-real-ip',
              'req.body.deviceId',
              'req.remoteAddress',
              'req.remotePort',
              'res.headers.set-cookie',
            ],
            autoLogging: {
              ignore: (req) => req.url?.startsWith('/health') ?? false,
            },
          },
        };
      },
    }),

    RedisModule,

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const db = config.getOrThrow<DatabaseConfig>('database');
        return {
          type: 'postgres' as const,
          host: db.host,
          port: db.port,
          username: db.username,
          password: db.password,
          database: db.database,
          ssl: db.ssl ? { rejectUnauthorized: false } : false,
          autoLoadEntities: true,
          // The only way the schema is built. See `DatabaseConfig.synchronize`
          // for why there is no migration chain behind it.
          synchronize: db.synchronize,
        };
      },
    }),

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: buildBullRedisOptions(
          config.getOrThrow<RedisConfig>('redis'),
        ),
      }),
    }),

    CacheModule.registerAsync({
      isGlobal: true,
      inject: [CACHE_STORE],
      useFactory: (store: KeyvRedis<unknown>) => ({
        stores: [store],
        ttl: 60_000,
      }),
    }),

    ThrottlerModule.forRootAsync({
      inject: [ConfigService, REDIS_CLIENT],
      useFactory: (config: ConfigService, redis: Redis) => {
        const throttle = config.getOrThrow<ThrottleConfig>('throttle');
        return {
          throttlers: [{ ttl: throttle.ttlMs, limit: throttle.limit }],
          // Redis-backed so limits hold across replicas rather than
          // per-process. Handed the shared client rather than options, so the
          // storage does not open — and then strand — a connection of its own.
          storage: new ThrottlerStorageRedisService(redis),
        };
      },
    }),

    EventEmitterModule.forRoot({ maxListeners: 20, verboseMemoryLeak: true }),

    ScoringModule,
    AuthModule,
    UsersModule,
    CatalogModule,
    CurrencyModule,
    MediaModule,
    DailyModule,
    SessionsModule,
    LeaderboardModule,
    FriendsModule,
    MatchesModule,
    NotificationsModule,
    HomeModule,
    LandingModule,
    AdminModule,
    JobsModule,
    ManifestModule,
    HealthModule,
  ],
  providers: [
    // Authentication is the default; `@Public()` is the deliberate exception.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Order matters, and not only for readability: the throttler keys on the
    // authenticated account, which only exists once the guard above has run.
    // Reversing these two silently reverts every limit to per-IP.
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    SchemaExtras,
  ],
})
export class AppModule {}
