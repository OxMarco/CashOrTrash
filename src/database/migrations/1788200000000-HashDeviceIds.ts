import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Replaces every stored device id with its SHA-256 digest.
 *
 * The device id is the account's only credential and it never expires, so the
 * plaintext column made a read of the `user` table equivalent to a login for
 * every player in it. From here on the table holds `hashDeviceId(id)` — see
 * `src/modules/users/device-id.ts` — and the application hashes what a client
 * presents before looking it up.
 *
 * The expression below must produce exactly what `hashDeviceId` produces:
 * lowercase hex of SHA-256 over the UTF-8 bytes. `sha256()` is built into
 * PostgreSQL 11+ (the deployment runs 17), so no `pgcrypto`. The ids accepted
 * at the API are restricted to `[A-Za-z0-9._:-]`, so the UTF-8 encoding is the
 * ASCII one and there is no normalisation question to get wrong.
 *
 * The column is renamed as well as rewritten, so that anything still asking
 * for the plaintext `deviceId` — an old replica during a rolling deploy above
 * all — fails on a missing column instead of inserting an unhashed id that the
 * new code would never find again. The unique index follows the column and
 * keeps its name.
 *
 * One `UPDATE` over the whole table, which is a single statement whose length
 * grows with the player count — so the pool's `statement_timeout` is lifted for
 * this transaction only. Migrations run at boot on the application's pool, and
 * a rewrite that times out rolls back and fails every boot after it the same
 * way, which is an outage rather than a slow deploy.
 */
export class HashDeviceIds1788200000000 implements MigrationInterface {
  name = 'HashDeviceIds1788200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL statement_timeout = 0`);
    await queryRunner.query(
      `UPDATE "user" SET "deviceId" = encode(sha256(convert_to("deviceId", 'UTF8')), 'hex')`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" RENAME COLUMN "deviceId" TO "deviceIdHash"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" ALTER COLUMN "deviceIdHash" TYPE character varying(64)`,
    );
  }

  /**
   * Irreversible by construction: a digest cannot be turned back into the id it
   * was taken from, and restoring the column with the digests still in it would
   * log every player out for good — each would register as a brand-new account
   * on their next launch. Restore the pre-migration backup instead.
   */
  public down(): Promise<void> {
    return Promise.reject(
      new Error(
        'HashDeviceIds1788200000000 cannot be reverted: device ids were ' +
          'replaced by their SHA-256 digests. Restore the database backup ' +
          'taken before this migration ran.',
      ),
    );
  }
}
