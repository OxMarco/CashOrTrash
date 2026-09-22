// Must come first. globalSetup is loaded outside Jest's module registry, so
// its `require` chain bypasses `moduleNameMapper` — without this, the `src/*`
// path alias inside the entity modules fails to resolve.
import 'tsconfig-paths/register';

import { DataSource } from 'typeorm';
import { join } from 'node:path';

import { hashAdminPassword } from '../../src/modules/admin/admin-password';
import { installCatalogue } from './catalogue-fixture';
import { applyEnv, startStack } from './containers';

/**
 * Runs once for the whole e2e run, before any worker is forked — which is why
 * it is the right place to point the environment at throwaway containers.
 * Everything downstream (`data-source.ts`, `@nestjs/config`) reads
 * `process.env`, so from here on no spec can reach the developer's database.
 */
export default async function globalSetup(): Promise<void> {
  const startedAt = Date.now();
  const stack = await startStack();
  applyEnv(stack);
  process.env.ADMIN_PASSWORD_HASH = await hashAdminPassword(
    'test-admin-password',
  );
  process.env.ADMIN_JWT_SECRET =
    'test-admin-jwt-secret-that-is-longer-than-thirty-two-characters';
  // Off for every suite but `billing`, which turns it back on for itself: the
  // rest play more quick rounds per player than any free allowance, and are
  // proving other things.
  process.env.FREE_QUICK_ROUNDS_PER_DAY = '0';

  // Built here rather than imported from `src/database/data-source`: that
  // module snapshots the environment at import time, and we have only just
  // rewritten it.
  const dataSource = new DataSource({
    type: 'postgres',
    host: stack.postgres.getHost(),
    port: stack.postgres.getPort(),
    username: stack.postgres.getUsername(),
    password: stack.postgres.getPassword(),
    database: stack.postgres.getDatabase(),
    entities: [join(__dirname, '..', '..', 'src', '**', '*.entity.{ts,js}')],
    migrations: [
      join(__dirname, '..', '..', 'src', 'database', 'migrations', '*.{ts,js}'),
    ],
    migrationsRun: true,
    synchronize: false,
  });

  await dataSource.initialize();
  try {
    // The one index entity metadata cannot express. SchemaExtras verifies it
    // when the app boots, but the fixture below runs before any app exists.
    await dataSource.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_theme_single_active_mystery"
         ON "theme" ((true)) WHERE "isMystery" = true AND "active" = true`,
    );
    await installCatalogue(dataSource);
  } finally {
    await dataSource.destroy();
  }

  process.stdout.write(
    `\n[e2e] stack ready in ${Math.round((Date.now() - startedAt) / 1000)}s ` +
      `(postgres :${stack.postgres.getPort()}, redis :${stack.redis.getPort()})\n`,
  );
}
