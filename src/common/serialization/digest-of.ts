import { createHash } from 'node:crypto';

/**
 * A short, stable digest of a JSON-serialisable payload.
 *
 * The unit of cache invalidation for clients: a response's digest is published
 * in the manifest, and an app compares it against the one it last stored to
 * decide whether the copy on disk is still the copy the server would send.
 *
 * Deriving the version *from* the payload rather than tracking it alongside is
 * what makes that trustworthy. A counter bumped by hand needs every write path
 * to remember, and the failure is silent in the worst direction — clients keep
 * serving content the server has already replaced. There is no equivalent
 * mistake here: if the bytes differ, the digest differs.
 *
 * The corollary is that the payload must be *deterministic*. A response that
 * embeds a timestamp, or orders rows without a tiebreak, changes its digest on
 * every call and turns the manifest into a refetch-always instruction.
 *
 * Sixteen hex characters — 64 bits. This is a change detector, not a security
 * boundary: nothing decides access on it, so the only real cost of a collision
 * is one missed refresh, and at 64 bits that is not going to happen to anyone.
 */
export function digestOf(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 16);
}
