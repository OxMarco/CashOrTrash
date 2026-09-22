import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';

import { attachRealtime, configureApp } from './app.bootstrap';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { trustProxy } from './config/proxy';
import { createOpenApiDocument } from './openapi';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Production has exactly one front-facing proxy (Traefik). Trusting every
      // hop lets a caller-supplied X-Forwarded-For become request.ip, which is
      // also the throttler identity. A one-hop boundary, from a private peer
      // only, selects the address Traefik observed and ignores any farther,
      // caller-injected entries — see `trustProxy`.
      trustProxy,
      bodyLimit: 256 * 1024,
    }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(PinoLogger));

  const config = app.get(ConfigService);
  const appConfig = config.getOrThrow<AppConfig>('app');

  await configureApp(app, appConfig);
  await attachRealtime(app);

  app.enableShutdownHooks();

  if (appConfig.swaggerEnabled) {
    SwaggerModule.setup('docs', app, createOpenApiDocument(app), {
      jsonDocumentUrl: 'docs/openapi.json',
      // The JSON contract is what generates the mobile client. Disabling the
      // bundled static UI removes an unnecessary file-serving attack surface.
      ui: false,
      raw: ['json'],
    });
  }

  await app.listen(appConfig.port, '0.0.0.0');
}

void bootstrap();
