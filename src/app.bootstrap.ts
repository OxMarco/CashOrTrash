import { ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyHelmet from '@fastify/helmet';

import { RedisIoAdapter } from './common/adapters/redis-io.adapter';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { DtoSerializerInterceptor } from './common/interceptors/dto-serializer.interceptor';
import { AppConfig } from './config/configuration';

/**
 * Every global that shapes a response lives here rather than in `main.ts`, so
 * the e2e suite can boot an application that is configured *identically* to
 * production. That matters most for the serializer: a test app that installed
 * its own interceptors would prove nothing about whether the real one keeps
 * `truePriceCents` off the wire.
 */
/**
 * Paths that sit outside the versioned API. Probes, so orchestrators need not
 * know the version; and item photography, whose URLs are stored in
 * `item.photoUrl` and would otherwise be invalidated wholesale by an API
 * version bump that changed nothing about an image.
 *
 * `*path` rather than `*`: Nest 11 matches with path-to-regexp v8, where a bare
 * wildcard is a syntax error and a named one is required.
 */
export const UNPREFIXED_ROUTES = ['health/live', 'health/ready', 'media/*path'];

/**
 * Response security headers.
 *
 * This API is JSON and item photography — there is no HTML surface left since
 * the server-rendered admin panel was removed, and the catalogue is now built
 * from `items/` at deploy time instead. So the policy denies every active
 * content type outright rather than carving out exceptions: no scripts, no
 * styles, no fonts, no frames, no form posts. Nothing here is meant to render
 * as a document, and a directive loosening later should have to justify itself.
 *
 * `imgSrc` keeps `'self'` for `/media`, which a browser genuinely does render.
 */
const HELMET_OPTIONS = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'none'"],
      styleSrc: ["'none'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'none'"],
      connectSrc: ["'self'"],
      formAction: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      objectSrc: ["'none'"],
      // Only meaningful once served over TLS, which production does at the
      // proxy. Harmless on a plain-HTTP development origin.
      upgradeInsecureRequests: [],
    },
  },
  // Helmet defaults this to `same-origin`, which would break the one thing on
  // this server that is *meant* to be read cross-origin: item photographs. The
  // app's web target runs on its own origin and loads `/media/...` from here,
  // and a same-origin CORP turns every one of those into a blocked image with
  // no CORS error to explain it. The bytes are public catalogue content; the
  // API that decides who may *play* is a separate surface behind a bearer
  // token, and it is not what this header protects.
  crossOriginResourcePolicy: { policy: 'cross-origin' as const },
} as const;

export async function configureApp(
  app: NestFastifyApplication,
  appConfig: AppConfig,
): Promise<void> {
  app.setGlobalPrefix(appConfig.apiPrefix, { exclude: UNPREFIXED_ROUTES });

  await app.register(fastifyHelmet, HELMET_OPTIONS);

  // For the app's web target only — native clients never preflight. Its
  // requests carry the X-App-* identity headers, and a custom header without
  // CORS consent fails every browser call before it leaves the machine. Any
  // origin in development; in production exactly the configured list, and no
  // browser access at all when none is set.
  const corsOrigins = appConfig.corsOrigins ?? [];
  app.enableCors({
    origin:
      appConfig.env === 'development'
        ? true
        : corsOrigins.length > 0
          ? corsOrigins
          : false,
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'x-app-version',
      'x-app-platform',
    ],
    maxAge: 86_400,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  /**
   * Layer 2 of the three guarding `truePriceCents`. `excludeExtraneousValues`
   * inverts the default: a field reaches the client only if a response DTO
   * explicitly `@Expose()`s it. Opt-in, not opt-out — forgetting a decorator
   * omits data rather than leaking it.
   */
  app.useGlobalInterceptors(new DtoSerializerInterceptor(app.get(Reflector)));

  app.useGlobalFilters(new AllExceptionsFilter());
}

/**
 * Separate from `configureApp` only because it awaits a Redis connection.
 * Without the Redis adapter, socket rooms would be per-process and a
 * head-to-head match would go silent whenever the two players landed on
 * different replicas.
 */
export async function attachRealtime(
  app: NestFastifyApplication,
): Promise<void> {
  const adapter = new RedisIoAdapter(app);
  await adapter.connectToRedis();
  app.useWebSocketAdapter(adapter);
}
