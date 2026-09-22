import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The two columns freemium needs on `user`.
 *
 * `billingId` is the id RevenueCat knows the player by. Not `user.id`: that is
 * a sequence, and RevenueCat's public SDK key — which ships in every install —
 * can read any customer whose id it can guess. A random uuid per player makes
 * the guess the whole problem. Existing rows are backfilled by the default.
 *
 * `premiumExpiresAt` is the server's copy of the `premium` entitlement, read
 * back from RevenueCat and never taken from the client. Null means free; a
 * past value means lapsed, so an expiry takes effect without anyone having to
 * tell the server about it.
 */
export class AddBilling1788400000000 implements MigrationInterface {
  name = 'AddBilling1788400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL statement_timeout = 0`);
    await queryRunner.query(
      `ALTER TABLE "user" ADD "billingId" uuid NOT NULL DEFAULT uuid_generate_v4()`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD "premiumExpiresAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_user_billing_id" ON "user" ("billingId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uq_user_billing_id"`);
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN "premiumExpiresAt"`,
    );
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "billingId"`);
  }
}
