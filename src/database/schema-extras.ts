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
 * the price of admission for anything added to this list.
 *
 * With the migration chain gone, this is now the *only* place schema that the
 * entities cannot describe can live. Every environment builds from
 * `synchronize`, and synchronize drops what it cannot account for — so an index
 * that is not expressible as metadata and not listed here does not merely fail
 * to be created, it gets removed on the next boot.
 */
const EXTRA_DDL: readonly string[] = [
  // The picker renders exactly one mystery row, and "two active mystery
  // themes" is a state no service-level check can be trusted to prevent under
  // concurrency. Indexed on a constant so the index holds at most one row.
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_theme_single_active_mystery"
     ON "theme" ((true)) WHERE "isMystery" = true AND "active" = true`,
  // Serves the per-account round budget, which counts one player's quick and
  // head-to-head sessions in the last hour on every Play tap. Partial and
  // descending, so the count reads the newest rows for one user and stops.
  `CREATE INDEX IF NOT EXISTS "ix_game_session_user_dealt_recent"
     ON "game_session" ("userId", "createdAt" DESC)
     WHERE mode IN ('quick', 'h2h')`,
  // Its predecessor covered `mode = 'quick'` alone, which no query asks for any
  // more. `IF EXISTS` because a database built after the rename never had it.
  `DROP INDEX IF EXISTS "ix_game_session_user_quick_recent"`,
  // Serves the nightly invite sweep, which asks for pending matches older than
  // the TTL. Partial, because the answer is always a handful of open invites
  // and the alternative is a scan of every match ever played.
  `CREATE INDEX IF NOT EXISTS "ix_match_pending_created"
     ON "match" ("createdAt") WHERE status = 'pending'`,
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
