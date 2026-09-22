import { createHash } from 'node:crypto';

/**
 * The only form in which a device id is ever kept.
 *
 * A device id is the account's one and only credential — there is no password
 * behind it — and it never expires. Stored as-is, a read of the `user` table (a
 * leaked backup, an over-broad support query) would hand over a working login
 * for every player at once. Stored as a digest, the same read yields nothing
 * that `POST /v1/auth/anonymous` will accept.
 *
 * Unsalted on purpose: lookup is by equality on a unique index, so the digest
 * has to be deterministic. That is sound here because the input is not a
 * human-chosen secret — clients generate a random UUID-sized id, which leaves
 * nothing for a dictionary to guess.
 *
 * Lowercase hex of SHA-256 over the UTF-8 bytes. The migration that hashed the
 * pre-existing rows computes exactly this in SQL —
 * `encode(sha256(convert_to("deviceId", 'UTF8')), 'hex')` — and the two must
 * never drift apart, or every returning player becomes a new one.
 */
export const hashDeviceId = (deviceId: string): string =>
  createHash('sha256').update(deviceId, 'utf8').digest('hex');
