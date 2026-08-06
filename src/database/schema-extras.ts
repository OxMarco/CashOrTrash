import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * The schema `synchronize` cannot describe.
 *
 * TypeORM builds indexes from entity metadata, and metadata has no way to say
 * "unique across a constant expression, filtered by a predicate". So the one
 * index below has no decorator to live on, and `synchronize` — which drops
 * whatever it finds on the table and cannot account for — would remove it on
 * the next boot. Reapplying it here keeps the invariant holding in every
 * environment, on the same boot that built the rest of the schema.
 *
 * `IF NOT EXISTS` makes every statement here safe to run on each boot; that is
 * the price of admission for anything added to this list. It is also why this
 * runs unconditionally: with no migrations in the project, a boot that skipped
 * it would be the only path by which the index never got created at all.
 */
const EXTRA_DDL: readonly string[] = [
  // The picker renders exactly one mystery row, and "two active mystery
  // themes" is a state no service-level check can be trusted to prevent under
  // concurrency. Indexed on a constant so the index holds at most one row.
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_theme_single_active_mystery"
     ON "theme" ((true)) WHERE "isMystery" = true AND "active" = true`,
];

@Injectable()
export class SchemaExtras implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchemaExtras.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const statement of EXTRA_DDL) {
      try {
        await this.dataSource.query(statement);
      } catch (error) {
        // Worth shouting about — the database is now missing a guarantee the
        // code above it assumes — but not worth refusing to start over, which
        // would leave a developer with an API that will not boot and no
        // obvious reason why.
        this.logger.error(
          `Could not apply schema extra: ${statement.trim().split('\n')[0]}…`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }
}
