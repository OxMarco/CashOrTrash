/**
 * Writes `openapi.json` — the contract the mobile client generates its wire
 * types from.
 *
 *   npm run openapi:emit
 *
 * Commit the result. It is the only thing standing between a field renamed
 * here and a decoder in the app that goes on reading the old name until a
 * player hits the round that needs it.
 *
 * Runs with no database, no Redis and no listening socket, which is what makes
 * it usable in CI. Nest's preview mode builds the module graph without
 * instantiating a single provider, and the Swagger scanner reads decorator
 * metadata off the controller and DTO *classes* rather than off live
 * instances — so nothing here ever opens a connection.
 *
 * Runs against `dist`, and must: the `@nestjs/swagger` CLI plugin (see
 * `nest-cli.json`) is what infers a DTO's schema from its plain TypeScript
 * types, and it runs during `nest build`. Emitted straight from source through
 * ts-node the same document comes back with 9 schemas instead of 31 — not an
 * error, just a contract describing almost nothing, which is the worst of the
 * available outcomes. Hence `npm run openapi:emit` building first.
 */
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { UNPREFIXED_ROUTES } from '../src/app.bootstrap';
import { AppModule } from '../src/app.module';
import { createOpenApiDocument } from '../src/openapi';

// Relative to the package root, not to `__dirname`: this file runs from
// `dist/scripts`, where `..` is the build output rather than the repository.
const OUTPUT_PATH = join(process.cwd(), 'openapi.json');

/**
 * The document has to carry the paths a client actually calls, so the prefix
 * is applied exactly as `configureApp` applies it. Read from the environment
 * with the same default the env schema declares, because a document emitted
 * without it would describe `/sessions` for an API served at `/v1/sessions`.
 */
const API_PREFIX = process.env.API_PREFIX ?? 'v1';

async function main(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { preview: true, logger: false },
  );

  app.setGlobalPrefix(API_PREFIX, { exclude: UNPREFIXED_ROUTES });

  const document = createOpenApiDocument(app);
  await app.close();

  // Trailing newline and two-space indent so the committed file is a readable
  // diff rather than one very long line whenever a field changes.
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(document, null, 2)}\n`);

  const paths = Object.keys(document.paths ?? {}).length;
  const schemas = Object.keys(document.components?.schemas ?? {}).length;
  console.log(`Wrote ${OUTPUT_PATH} — ${paths} paths, ${schemas} schemas`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
