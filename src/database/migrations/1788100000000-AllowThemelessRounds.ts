import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a quick round and a match be dealt with no category behind them.
 *
 * The mystery mix draws from the whole catalogue, so there is no theme row to
 * point a session or a match at — the same state a daily challenge has always
 * been in. Until now only `daily` was allowed it: the mode check demanded a
 * theme for the other two, and `match."themeId"` was NOT NULL, so the mix
 * could only be dealt through a hand-inserted `isMystery` theme row.
 *
 * The mode check keeps its job. What separates the three modes is the field
 * each one owns — `dailyDate` for the calendar's round, `matchId` for a match
 * — and those are still required and still mutually exclusive.
 */
export class AllowThemelessRounds1788100000000 implements MigrationInterface {
  name = 'AllowThemelessRounds1788100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "game_session" DROP CONSTRAINT "ck_game_session_mode_fields"`,
    );
    await queryRunner.query(
      `ALTER TABLE "game_session" ADD CONSTRAINT "ck_game_session_mode_fields" CHECK (` +
        `("mode" = 'daily' AND "dailyDate" IS NOT NULL AND "themeId" IS NULL AND "matchId" IS NULL) OR ` +
        `("mode" = 'quick' AND "dailyDate" IS NULL AND "matchId" IS NULL) OR ` +
        `("mode" = 'h2h' AND "dailyDate" IS NULL AND "matchId" IS NOT NULL))`,
    );

    await queryRunner.query(
      `ALTER TABLE "match" ALTER COLUMN "themeId" DROP NOT NULL`,
    );
  }

  /**
   * Reversible only while no mystery round has been played: restoring NOT NULL
   * over a themeless session or match is exactly the state this migration
   * exists to allow, and Postgres will refuse it rather than discard rounds.
   * Clear those rows first if a revert is really wanted.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "match" ALTER COLUMN "themeId" SET NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "game_session" DROP CONSTRAINT "ck_game_session_mode_fields"`,
    );
    await queryRunner.query(
      `ALTER TABLE "game_session" ADD CONSTRAINT "ck_game_session_mode_fields" CHECK (` +
        `("mode" = 'daily' AND "dailyDate" IS NOT NULL AND "themeId" IS NULL AND "matchId" IS NULL) OR ` +
        `("mode" = 'quick' AND "dailyDate" IS NULL AND "themeId" IS NOT NULL AND "matchId" IS NULL) OR ` +
        `("mode" = 'h2h' AND "dailyDate" IS NULL AND "themeId" IS NOT NULL AND "matchId" IS NOT NULL))`,
    );
  }
}
