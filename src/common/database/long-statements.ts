import { EntityManager } from 'typeorm';

/**
 * The statement timeout for work that is expected to be slow.
 *
 * The pool's `DATABASE_STATEMENT_TIMEOUT_MS` is sized for request traffic,
 * where a statement still running after a few seconds is a bug or a lock pile-
 * up and should be cut off before it holds a connection hostage. A handful of
 * whole-table jobs — ranking a day's board, rebuilding a leaderboard, the
 * rolling theme-difficulty aggregate — are one statement each whose cost grows
 * with the player base, and the request budget would eventually start killing
 * them on a large day for no fault of their own. Generous, not unbounded: a
 * job wedged behind a lock should still give its connection back eventually.
 */
export const LONG_STATEMENT_TIMEOUT_MS = 5 * 60_000;

/**
 * Runs `work` in a transaction whose statements may take up to
 * `LONG_STATEMENT_TIMEOUT_MS`.
 *
 * `SET LOCAL`, so the raised limit ends with the transaction and never leaks to
 * whichever request borrows the pooled connection next — the reason this is a
 * transaction at all, even around a single read.
 */
export function withLongStatements<T>(
  manager: EntityManager,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return manager.transaction(async (transactional) => {
    await transactional.query(
      `SET LOCAL statement_timeout = ${LONG_STATEMENT_TIMEOUT_MS}`,
    );
    return work(transactional);
  });
}
