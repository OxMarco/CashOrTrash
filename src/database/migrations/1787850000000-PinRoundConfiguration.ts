import { MigrationInterface, QueryRunner } from 'typeorm';

export class PinRoundConfiguration1787850000000 implements MigrationInterface {
  name = 'PinRoundConfiguration1787850000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "daily_challenge" ADD "sliderMinCents" integer array, ADD "sliderMaxCents" integer array, ADD "scoringVersion" character varying(16)`,
    );
    await queryRunner.query(
      `ALTER TABLE "daily_challenge" ADD CONSTRAINT "ck_daily_challenge_slider_bounds" CHECK (("sliderMinCents" IS NULL) = ("sliderMaxCents" IS NULL) AND ("sliderMinCents" IS NULL OR (cardinality("sliderMinCents") = cardinality("itemIds") AND cardinality("sliderMaxCents") = cardinality("itemIds"))))`,
    );

    await queryRunner.query(
      `ALTER TABLE "match" ADD "sliderMinCents" integer array, ADD "sliderMaxCents" integer array, ADD "scoringVersion" character varying(16)`,
    );
    await queryRunner.query(
      `ALTER TABLE "match" ADD CONSTRAINT "ck_match_slider_bounds" CHECK (("sliderMinCents" IS NULL) = ("sliderMaxCents" IS NULL) AND ("sliderMinCents" IS NULL OR (cardinality("sliderMinCents") = cardinality("itemIds") AND cardinality("sliderMaxCents") = cardinality("itemIds"))))`,
    );

    await queryRunner.query(
      `ALTER TABLE "game_session" ADD "sliderMinCents" integer array, ADD "sliderMaxCents" integer array, ADD "scoringVersion" character varying(16), ADD "currentCurrency" character varying(3), ADD "currentExchangeRate" double precision`,
    );
    await queryRunner.query(
      `ALTER TABLE "game_session" ADD CONSTRAINT "ck_game_session_slider_bounds" CHECK (("sliderMinCents" IS NULL) = ("sliderMaxCents" IS NULL) AND ("sliderMinCents" IS NULL OR (cardinality("sliderMinCents") = cardinality("itemIds") AND cardinality("sliderMaxCents") = cardinality("itemIds"))))`,
    );
    await queryRunner.query(
      `ALTER TABLE "game_session" ADD CONSTRAINT "ck_game_session_current_quote" CHECK (("currentCurrency" IS NULL) = ("currentExchangeRate" IS NULL) AND ("currentExchangeRate" IS NULL OR "currentExchangeRate" > 0))`,
    );

    await queryRunner.query(
      `ALTER TABLE "session_round" ADD "currency" character varying(3), ADD "exchangeRate" double precision`,
    );
    await queryRunner.query(
      `ALTER TABLE "session_round" ADD CONSTRAINT "ck_session_round_quote" CHECK (("currency" IS NULL) = ("exchangeRate" IS NULL) AND ("exchangeRate" IS NULL OR "exchangeRate" > 0))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "session_round" DROP CONSTRAINT "ck_session_round_quote"`,
    );
    await queryRunner.query(
      `ALTER TABLE "session_round" DROP COLUMN "exchangeRate", DROP COLUMN "currency"`,
    );

    await queryRunner.query(
      `ALTER TABLE "game_session" DROP CONSTRAINT "ck_game_session_current_quote"`,
    );
    await queryRunner.query(
      `ALTER TABLE "game_session" DROP CONSTRAINT "ck_game_session_slider_bounds"`,
    );
    await queryRunner.query(
      `ALTER TABLE "game_session" DROP COLUMN "currentExchangeRate", DROP COLUMN "currentCurrency", DROP COLUMN "scoringVersion", DROP COLUMN "sliderMaxCents", DROP COLUMN "sliderMinCents"`,
    );

    await queryRunner.query(
      `ALTER TABLE "match" DROP CONSTRAINT "ck_match_slider_bounds"`,
    );
    await queryRunner.query(
      `ALTER TABLE "match" DROP COLUMN "scoringVersion", DROP COLUMN "sliderMaxCents", DROP COLUMN "sliderMinCents"`,
    );

    await queryRunner.query(
      `ALTER TABLE "daily_challenge" DROP CONSTRAINT "ck_daily_challenge_slider_bounds"`,
    );
    await queryRunner.query(
      `ALTER TABLE "daily_challenge" DROP COLUMN "scoringVersion", DROP COLUMN "sliderMaxCents", DROP COLUMN "sliderMinCents"`,
    );
  }
}
