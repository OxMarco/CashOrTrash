import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes the foreign keys into `user` that had none.
 *
 * Postgres indexes the referenced side of a foreign key, never the referencing
 * one. So every delete from `user` checked `match` three times over — host,
 * guest and winner, all `RESTRICT` — and cascaded into `friendship` by
 * `friendUserId`, each as a sequential scan, while account deletion held its
 * row locks. The guest and winner indexes are partial: a pending invite has no
 * guest and an unfinished or drawn game no winner, and neither is ever looked
 * up by the missing value.
 *
 * Plain `CREATE INDEX`, not `CONCURRENTLY`: migrations run in one transaction
 * at boot, where `CONCURRENTLY` is not allowed, and at these table sizes the
 * brief write lock is the cheaper trade. `statement_timeout` is lifted for the
 * transaction so a larger table than expected slows the deploy rather than
 * failing it.
 */
export class IndexUserForeignKeys1788300000000 implements MigrationInterface {
  name = 'IndexUserForeignKeys1788300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL statement_timeout = 0`);
    await queryRunner.query(
      `CREATE INDEX "ix_match_host_user" ON "match" ("hostUserId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_match_guest_user" ON "match" ("guestUserId") WHERE "guestUserId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_match_winner_user" ON "match" ("winnerUserId") WHERE "winnerUserId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_friendship_friend_user" ON "friendship" ("friendUserId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."ix_friendship_friend_user"`);
    await queryRunner.query(`DROP INDEX "public"."ix_match_winner_user"`);
    await queryRunner.query(`DROP INDEX "public"."ix_match_guest_user"`);
    await queryRunner.query(`DROP INDEX "public"."ix_match_host_user"`);
  }
}
