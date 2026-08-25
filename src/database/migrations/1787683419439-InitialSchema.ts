import { MigrationInterface, QueryRunner } from 'typeorm';

import { shouldCreateInitialSchema } from '../initial-schema-baseline';

export class InitialSchema1787683419439 implements MigrationInterface {
  name = 'InitialSchema1787683419439';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // A database booted before the migration chain existed already has this
    // exact schema. Verify it and return so TypeORM records the initial
    // migration as applied; a fresh database continues into the DDL below.
    if (!(await shouldCreateInitialSchema(queryRunner))) return;

    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "citext"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(
      `CREATE TABLE "user" ("id" SERIAL NOT NULL, "username" citext, "deviceId" character varying(128) NOT NULL, "avatarSeed" character varying(32) NOT NULL, "totalPoints" integer NOT NULL DEFAULT '0', "streakDays" integer NOT NULL DEFAULT '0', "streakLastPlayedOn" date, "bestRoundScore" integer NOT NULL DEFAULT '0', "registrationIp" character varying(45), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "ck_user_stats_nonnegative" CHECK ("totalPoints" >= 0 AND "streakDays" >= 0 AND "bestRoundScore" >= 0), CONSTRAINT "PK_cace4a159ff9f2512dd42373760" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_user_username" ON "user" ("username") WHERE "username" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_user_device_id" ON "user" ("deviceId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_user_registration_ip" ON "user" ("registrationIp") WHERE "registrationIp" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "theme_stat" ("themeId" integer NOT NULL, "avgErrorPct" double precision NOT NULL DEFAULT '0', "sampleSize" integer NOT NULL DEFAULT '0', "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_91493ab3d00b1be0d94fe0b58e7" PRIMARY KEY ("themeId"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "theme" ("id" SERIAL NOT NULL, "slug" character varying(64) NOT NULL, "name" character varying(64) NOT NULL, "iconName" character varying(32) NOT NULL DEFAULT 'basket', "sortOrder" integer NOT NULL DEFAULT '0', "isMystery" boolean NOT NULL DEFAULT false, "bonusPct" numeric(4,3) NOT NULL DEFAULT '0', "active" boolean NOT NULL DEFAULT true, CONSTRAINT "ck_theme_bonus_pct_range" CHECK ("bonusPct" >= 0 AND "bonusPct" <= 1), CONSTRAINT "PK_c1934d0b4403bf10c1ab0c18166" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_theme_slug" ON "theme" ("slug") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."item_origin_enum" AS ENUM('seed', 'crawler', 'manual', 'import')`,
    );
    await queryRunner.query(
      `CREATE TABLE "item" ("id" SERIAL NOT NULL, "title" character varying(120) NOT NULL, "conditionLine" character varying(160) NOT NULL, "sourceHash" character varying(64), "sourceName" character varying(256), "photoUrl" character varying(512) NOT NULL, "truePriceCents" integer NOT NULL, "themeId" integer NOT NULL, "sourceUrl" character varying(512), "origin" "public"."item_origin_enum" NOT NULL DEFAULT 'seed', "active" boolean NOT NULL DEFAULT true, "copyPending" boolean NOT NULL DEFAULT false, CONSTRAINT "ck_item_true_price_positive" CHECK ("truePriceCents" > 0), CONSTRAINT "PK_d3c0c71f23e7adcf952a1d13423" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_item_source_hash" ON "item" ("sourceHash") WHERE "sourceHash" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_item_theme_title" ON "item" ("themeId", "title") `,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_item_theme_active" ON "item" ("themeId", "active") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."match_status_enum" AS ENUM('pending', 'active', 'complete', 'expired')`,
    );
    await queryRunner.query(`CREATE TABLE "match" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "itemIds" integer array NOT NULL, "themeId" integer NOT NULL, "inviteCode" character varying(12) NOT NULL, "hostUserId" integer NOT NULL, "guestUserId" integer, "status" "public"."match_status_enum" NOT NULL DEFAULT 'pending', "hostScore" integer NOT NULL DEFAULT '0', "guestScore" integer NOT NULL DEFAULT '0', "winnerUserId" integer, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "completedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "ck_match_status_fields" CHECK (("status" IN ('pending', 'expired') AND "guestUserId" IS NULL AND "completedAt" IS NULL AND "winnerUserId" IS NULL) OR
   ("status" = 'active' AND "guestUserId" IS NOT NULL AND "completedAt" IS NULL AND "winnerUserId" IS NULL) OR
   ("status" = 'complete' AND "guestUserId" IS NOT NULL AND "completedAt" IS NOT NULL)), CONSTRAINT "ck_match_winner" CHECK ("winnerUserId" IS NULL OR "winnerUserId" = "hostUserId" OR "winnerUserId" = "guestUserId"), CONSTRAINT "ck_match_scores" CHECK ("hostScore" >= 0 AND "guestScore" >= 0), CONSTRAINT "ck_match_players" CHECK ("guestUserId" IS NULL OR "hostUserId" <> "guestUserId"), CONSTRAINT "ck_match_items" CHECK (cardinality("itemIds") > 0), CONSTRAINT "PK_92b6c3a6631dd5b24a67c69f69d" PRIMARY KEY ("id"))`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_match_invite_code" ON "match" ("inviteCode") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."game_session_mode_enum" AS ENUM('daily', 'quick', 'h2h')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."game_session_status_enum" AS ENUM('active', 'complete', 'abandoned')`,
    );
    await queryRunner.query(`CREATE TABLE "game_session" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" integer NOT NULL, "mode" "public"."game_session_mode_enum" NOT NULL, "themeId" integer, "dailyDate" date, "matchId" uuid, "itemIds" integer array NOT NULL, "currentIndex" integer NOT NULL DEFAULT '0', "totalScore" integer NOT NULL DEFAULT '0', "status" "public"."game_session_status_enum" NOT NULL DEFAULT 'active', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "completedAt" TIMESTAMP WITH TIME ZONE, "currentServedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "ck_game_session_completion" CHECK (("status" = 'complete' AND "currentIndex" = cardinality("itemIds") AND "completedAt" IS NOT NULL) OR
   ("status" <> 'complete' AND "completedAt" IS NULL)), CONSTRAINT "ck_game_session_score_nonnegative" CHECK ("totalScore" >= 0), CONSTRAINT "ck_game_session_progress" CHECK (cardinality("itemIds") > 0 AND "currentIndex" >= 0 AND "currentIndex" <= cardinality("itemIds")), CONSTRAINT "ck_game_session_mode_fields" CHECK (("mode" = 'daily' AND "dailyDate" IS NOT NULL AND "themeId" IS NULL AND "matchId" IS NULL) OR
   ("mode" = 'quick' AND "dailyDate" IS NULL AND "themeId" IS NOT NULL AND "matchId" IS NULL) OR
   ("mode" = 'h2h' AND "dailyDate" IS NULL AND "themeId" IS NOT NULL AND "matchId" IS NOT NULL)), CONSTRAINT "PK_58b630233711ccafbb0b2a904fc" PRIMARY KEY ("id"))`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_session_daily" ON "game_session" ("userId", "dailyDate") WHERE mode = 'daily'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_session_h2h" ON "game_session" ("userId", "matchId") WHERE mode = 'h2h' AND "matchId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_game_session_match" ON "game_session" ("matchId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_game_session_user_status" ON "game_session" ("userId", "status") `,
    );
    await queryRunner.query(
      `CREATE TABLE "session_round" ("sessionId" uuid NOT NULL, "roundIndex" integer NOT NULL, "itemId" integer NOT NULL, "loCents" integer NOT NULL, "hiCents" integer NOT NULL, "multiplier" numeric(5,3) NOT NULL, "basePoints" integer NOT NULL, "points" integer NOT NULL, "hit" boolean NOT NULL, "timedOut" boolean NOT NULL DEFAULT false, "elapsedMs" integer, "errorPct" double precision NOT NULL, "scoringVersion" character varying(16) NOT NULL, "placedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "ck_session_round_values" CHECK ("roundIndex" >= 0 AND "loCents" >= 0 AND "loCents" < "hiCents" AND "multiplier" > 0 AND "basePoints" >= 0 AND "points" >= 0 AND ("elapsedMs" IS NULL OR "elapsedMs" >= 0) AND (NOT "timedOut" OR "points" = 0)), CONSTRAINT "PK_5d674f80603dbfca6f04fb23cc2" PRIMARY KEY ("sessionId", "roundIndex"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."push_token_platform_enum" AS ENUM('ios', 'android')`,
    );
    await queryRunner.query(
      `CREATE TABLE "push_token" ("id" SERIAL NOT NULL, "userId" integer NOT NULL, "platform" "public"."push_token_platform_enum" NOT NULL, "token" character varying(512) NOT NULL, "timezoneOffsetMinutes" integer NOT NULL DEFAULT '0', "optInAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "locale" character varying(5) NOT NULL DEFAULT 'en', "active" boolean NOT NULL DEFAULT true, CONSTRAINT "ck_push_token_timezone_offset" CHECK ("timezoneOffsetMinutes" BETWEEN -720 AND 840), CONSTRAINT "PK_cdd834aa4f6dc2efd7df5041233" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_push_token_token" ON "push_token" ("token") `,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_push_token_user" ON "push_token" ("userId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "friendship" ("userId" integer NOT NULL, "friendUserId" integer NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "ck_friendship_distinct_users" CHECK ("userId" <> "friendUserId"), CONSTRAINT "PK_fb253b518a5123c59bc0e0a2410" PRIMARY KEY ("userId", "friendUserId"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "daily_challenge" ("challengeDate" date NOT NULL, "itemIds" integer array NOT NULL, "seed" character varying(64) NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_23d81b3a343b3731b004e4036a3" PRIMARY KEY ("challengeDate"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "item_copy" ("itemId" integer NOT NULL, "locale" character varying(5) NOT NULL, "title" character varying(160) NOT NULL, "conditionLine" character varying(220) NOT NULL, "writtenAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "ck_item_copy_not_english" CHECK ("locale" <> 'en'), CONSTRAINT "PK_4ef88103a595a3b1684c87cdd3e" PRIMARY KEY ("itemId", "locale"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_item_copy_locale" ON "item_copy" ("locale") `,
    );
    await queryRunner.query(
      `CREATE TABLE "daily_score" ("userId" integer NOT NULL, "challengeDate" date NOT NULL, "score" integer NOT NULL, "rank" integer, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "ck_daily_score_values" CHECK ("score" >= 0 AND ("rank" IS NULL OR "rank" > 0)), CONSTRAINT "PK_ae57c1aeea2c85ec97fb48a96e8" PRIMARY KEY ("userId", "challengeDate"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_daily_score_date_score" ON "daily_score" ("challengeDate", "score") `,
    );
    await queryRunner.query(
      `ALTER TABLE "theme_stat" ADD CONSTRAINT "fk_theme_stat_theme" FOREIGN KEY ("themeId") REFERENCES "theme"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "item" ADD CONSTRAINT "FK_3e027a2b5a133ad5d97ef28d155" FOREIGN KEY ("themeId") REFERENCES "theme"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "match" ADD CONSTRAINT "fk_match_theme" FOREIGN KEY ("themeId") REFERENCES "theme"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "match" ADD CONSTRAINT "fk_match_host_user" FOREIGN KEY ("hostUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "match" ADD CONSTRAINT "fk_match_guest_user" FOREIGN KEY ("guestUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "match" ADD CONSTRAINT "fk_match_winner_user" FOREIGN KEY ("winnerUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "game_session" ADD CONSTRAINT "fk_game_session_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "game_session" ADD CONSTRAINT "fk_game_session_theme" FOREIGN KEY ("themeId") REFERENCES "theme"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "game_session" ADD CONSTRAINT "fk_game_session_match" FOREIGN KEY ("matchId") REFERENCES "match"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "session_round" ADD CONSTRAINT "fk_session_round_item" FOREIGN KEY ("itemId") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "session_round" ADD CONSTRAINT "FK_547c9a35166b55a8427af5c3907" FOREIGN KEY ("sessionId") REFERENCES "game_session"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "push_token" ADD CONSTRAINT "fk_push_token_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "friendship" ADD CONSTRAINT "fk_friendship_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "friendship" ADD CONSTRAINT "fk_friendship_friend" FOREIGN KEY ("friendUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "item_copy" ADD CONSTRAINT "fk_item_copy_item" FOREIGN KEY ("itemId") REFERENCES "item"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "daily_score" ADD CONSTRAINT "fk_daily_score_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "daily_score" DROP CONSTRAINT "fk_daily_score_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "item_copy" DROP CONSTRAINT "fk_item_copy_item"`,
    );
    await queryRunner.query(
      `ALTER TABLE "friendship" DROP CONSTRAINT "fk_friendship_friend"`,
    );
    await queryRunner.query(
      `ALTER TABLE "friendship" DROP CONSTRAINT "fk_friendship_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "push_token" DROP CONSTRAINT "fk_push_token_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "session_round" DROP CONSTRAINT "FK_547c9a35166b55a8427af5c3907"`,
    );
    await queryRunner.query(
      `ALTER TABLE "session_round" DROP CONSTRAINT "fk_session_round_item"`,
    );
    await queryRunner.query(
      `ALTER TABLE "game_session" DROP CONSTRAINT "fk_game_session_match"`,
    );
    await queryRunner.query(
      `ALTER TABLE "game_session" DROP CONSTRAINT "fk_game_session_theme"`,
    );
    await queryRunner.query(
      `ALTER TABLE "game_session" DROP CONSTRAINT "fk_game_session_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "match" DROP CONSTRAINT "fk_match_winner_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "match" DROP CONSTRAINT "fk_match_guest_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "match" DROP CONSTRAINT "fk_match_host_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "match" DROP CONSTRAINT "fk_match_theme"`,
    );
    await queryRunner.query(
      `ALTER TABLE "item" DROP CONSTRAINT "FK_3e027a2b5a133ad5d97ef28d155"`,
    );
    await queryRunner.query(
      `ALTER TABLE "theme_stat" DROP CONSTRAINT "fk_theme_stat_theme"`,
    );
    await queryRunner.query(`DROP INDEX "public"."ix_daily_score_date_score"`);
    await queryRunner.query(`DROP TABLE "daily_score"`);
    await queryRunner.query(`DROP INDEX "public"."ix_item_copy_locale"`);
    await queryRunner.query(`DROP TABLE "item_copy"`);
    await queryRunner.query(`DROP TABLE "daily_challenge"`);
    await queryRunner.query(`DROP TABLE "friendship"`);
    await queryRunner.query(`DROP INDEX "public"."ix_push_token_user"`);
    await queryRunner.query(`DROP INDEX "public"."uq_push_token_token"`);
    await queryRunner.query(`DROP TABLE "push_token"`);
    await queryRunner.query(`DROP TYPE "public"."push_token_platform_enum"`);
    await queryRunner.query(`DROP TABLE "session_round"`);
    await queryRunner.query(
      `DROP INDEX "public"."ix_game_session_user_status"`,
    );
    await queryRunner.query(`DROP INDEX "public"."ix_game_session_match"`);
    await queryRunner.query(`DROP INDEX "public"."uq_session_h2h"`);
    await queryRunner.query(`DROP INDEX "public"."uq_session_daily"`);
    await queryRunner.query(`DROP TABLE "game_session"`);
    await queryRunner.query(`DROP TYPE "public"."game_session_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."game_session_mode_enum"`);
    await queryRunner.query(`DROP INDEX "public"."uq_match_invite_code"`);
    await queryRunner.query(`DROP TABLE "match"`);
    await queryRunner.query(`DROP TYPE "public"."match_status_enum"`);
    await queryRunner.query(`DROP INDEX "public"."ix_item_theme_active"`);
    await queryRunner.query(`DROP INDEX "public"."uq_item_theme_title"`);
    await queryRunner.query(`DROP INDEX "public"."uq_item_source_hash"`);
    await queryRunner.query(`DROP TABLE "item"`);
    await queryRunner.query(`DROP TYPE "public"."item_origin_enum"`);
    await queryRunner.query(`DROP INDEX "public"."uq_theme_slug"`);
    await queryRunner.query(`DROP TABLE "theme"`);
    await queryRunner.query(`DROP TABLE "theme_stat"`);
    await queryRunner.query(`DROP INDEX "public"."ix_user_registration_ip"`);
    await queryRunner.query(`DROP INDEX "public"."uq_user_device_id"`);
    await queryRunner.query(`DROP INDEX "public"."uq_user_username"`);
    await queryRunner.query(`DROP TABLE "user"`);
  }
}
