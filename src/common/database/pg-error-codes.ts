/** Postgres SQLSTATE codes we translate into domain behaviour. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';

export const isPgError = (error: unknown, code: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (('code' in error && (error as { code?: string }).code === code) ||
    ('driverError' in error &&
      (error as { driverError?: { code?: string } }).driverError?.code ===
        code));
