import { DatabaseConfig } from '../config/configuration';

/**
 * `node-postgres` pool and client options, passed through TypeORM's `extra`.
 *
 * Without them the pool was `pg`'s defaults: ten clients, an unbounded wait for
 * one, and no limit on how long a statement may run. The last two are what turn
 * one slow query or a lock pile-up into every request hanging at once — each
 * waiting for a client held by another that is itself waiting — with nothing
 * ever failing fast enough to show up as an error.
 *
 * `statement_timeout` is set per connection at startup, so it applies to every
 * statement from this pool, including inside transactions. It bounds single
 * statements, not transactions or held connections: the item-copy pass keeps a
 * client for its advisory lock across minutes of model calls and is unaffected.
 */
export const databasePoolOptions = (
  db: Pick<
    DatabaseConfig,
    'poolMax' | 'connectionTimeoutMs' | 'statementTimeoutMs'
  >,
) => ({
  max: db.poolMax,
  connectionTimeoutMillis: db.connectionTimeoutMs,
  statement_timeout: db.statementTimeoutMs,
});
