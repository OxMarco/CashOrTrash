import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';

/**
 * The OpenAPI document, built in one place because it now has two consumers
 * that must not disagree: `/docs/openapi.json` on a running server, and the
 * snapshot `scripts/emit-openapi.ts` writes for the mobile client to generate
 * its wire types from. A document built twice is a contract that drifts, and
 * the whole value of generating the client is that it cannot.
 */
export const createOpenApiDocument = (app: INestApplication): OpenAPIObject =>
  cleanupOpenApiDoc(
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('CashOrTrash API')
        .setDescription(
          'Price-guessing game API. `truePriceCents` is returned by exactly ' +
            'one endpoint: POST /sessions/:id/rounds/:index/bet.',
        )
        .setVersion('1.0')
        .addBearerAuth()
        .build(),
    ),
  );
