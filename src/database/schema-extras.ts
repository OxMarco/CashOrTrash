import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Schema invariants TypeORM metadata cannot describe.
 *
 * TypeORM builds indexes from entity metadata, and metadata has no way to say
 * "unique across a constant expression, filtered by a predicate". So the one
 * index below has no decorator to live on. Reapplying it here keeps the
 * invariant holding after migrations and verifies it on every boot.
 *
 * `IF NOT EXISTS` makes every statement here safe to run on each boot; that is
 * the price of admission for anything added to this list.
 *
 * A failure is fatal. The services below assume these guarantees exist; serving
 * traffic without them is worse than refusing startup with the exact DDL error.
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
  // Serves the hourly nudge sweep, which asks for the active tokens in the
  // handful of timezone buckets currently at the target local hour. Without it
  // that is a scan of every token ever registered, once an hour, to find the
  // few per cent of them it is actually the evening for.
  `CREATE INDEX IF NOT EXISTS "ix_push_token_active_offset"
     ON "push_token" ("timezoneOffsetMinutes") WHERE active = true`,
  // Serves the hourly theme-stat recompute, which now aggregates a rolling
  // window rather than all history. Without it the window bound is read off a
  // full scan of every round ever played, which is the cost the bound exists
  // to avoid.
  `CREATE INDEX IF NOT EXISTS "ix_session_round_placed_at"
     ON "session_round" ("placedAt")`,
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
        this.logger.error(
          `Could not apply schema extra: ${statement.trim().split('\n')[0]}…`,
          error instanceof Error ? error.stack : String(error),
        );
        throw error;
      }
    }
  }
}
