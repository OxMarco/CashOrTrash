import { QueryRunner } from 'typeorm';

/**
 * The schema that existed immediately before migrations replaced
 * `synchronize`.
 *
 * An installation upgraded in place already has these tables but has no row in
 * TypeORM's migrations table. The initial migration must recognise that exact
 * situation and let TypeORM record it as applied; trying to create the tables
 * again makes every preserved development and production volume fail boot.
 *
 * Requiring every table and every column keeps the baseline fail-closed. A
 * partial or older schema is not silently blessed as current — it stops with a
 * message that tells the operator to restore/upgrade it deliberately.
 */
export const INITIAL_SCHEMA_COLUMNS = {
  user: [
    'id',
    'username',
    'deviceId',
    'avatarSeed',
    'totalPoints',
    'streakDays',
    'streakLastPlayedOn',
    'bestRoundScore',
    'registrationIp',
    'createdAt',
  ],
  theme_stat: ['themeId', 'avgErrorPct', 'sampleSize', 'updatedAt'],
  theme: [
    'id',
    'slug',
    'name',
    'iconName',
    'sortOrder',
    'isMystery',
    'bonusPct',
    'active',
  ],
  item: [
    'id',
    'title',
    'conditionLine',
    'sourceHash',
    'sourceName',
    'photoUrl',
    'truePriceCents',
    'themeId',
    'sourceUrl',
    'origin',
    'active',
    'copyPending',
  ],
  match: [
    'id',
    'itemIds',
    'themeId',
    'inviteCode',
    'hostUserId',
    'guestUserId',
    'status',
    'hostScore',
    'guestScore',
    'winnerUserId',
    'createdAt',
    'completedAt',
  ],
  game_session: [
    'id',
    'userId',
    'mode',
    'themeId',
    'dailyDate',
    'matchId',
    'itemIds',
    'currentIndex',
    'totalScore',
    'status',
    'createdAt',
    'completedAt',
    'currentServedAt',
  ],
  session_round: [
    'sessionId',
    'roundIndex',
    'itemId',
    'loCents',
    'hiCents',
    'multiplier',
    'basePoints',
    'points',
    'hit',
    'timedOut',
    'elapsedMs',
    'errorPct',
    'scoringVersion',
    'placedAt',
  ],
  push_token: [
    'id',
    'userId',
    'platform',
    'token',
    'timezoneOffsetMinutes',
    'optInAt',
    'locale',
    'active',
  ],
  friendship: ['userId', 'friendUserId', 'createdAt'],
  daily_challenge: ['challengeDate', 'itemIds', 'seed', 'createdAt'],
  item_copy: ['itemId', 'locale', 'title', 'conditionLine', 'writtenAt'],
  daily_score: ['userId', 'challengeDate', 'score', 'rank', 'updatedAt'],
} as const;

/** True for an empty database; false for a verified synchronize-era schema. */
export async function shouldCreateInitialSchema(
  queryRunner: QueryRunner,
): Promise<boolean> {
  const expected = Object.entries(INITIAL_SCHEMA_COLUMNS);

  // One at a time, not `Promise.all`. A QueryRunner owns a single PostgreSQL
  // client, and issuing overlapping queries on one client is deprecated in
  // `pg` 8 and removed in 9 — so the parallel version worked only by being
  // quietly serialised for us, and would have started throwing on a driver
  // bump, during a migration, at boot. Twelve catalogue lookups run once per
  // process start; there is nothing here worth the round trips.
  const presence: boolean[] = [];
  for (const [table] of expected) {
    presence.push(await queryRunner.hasTable(table));
  }

  if (presence.every((exists) => !exists)) return true;

  const missingTables = expected
    .filter((_, index) => !presence[index])
    .map(([table]) => table);
  if (missingTables.length > 0) {
    throw new Error(
      `Cannot baseline a partial pre-migration schema; missing tables: ${missingTables.join(', ')}`,
    );
  }

  for (const [tableName, requiredColumns] of expected) {
    const table = await queryRunner.getTable(tableName);
    if (!table) {
      throw new Error(
        `Cannot baseline pre-migration schema; missing table: ${tableName}`,
      );
    }

    const columns = new Set(table.columns.map((column) => column.name));
    const missingColumns = requiredColumns.filter(
      (column) => !columns.has(column),
    );
    if (missingColumns.length > 0) {
      throw new Error(
        `Cannot baseline pre-migration schema; ${tableName} is missing columns: ${missingColumns.join(', ')}`,
      );
    }
  }

  return false;
}
