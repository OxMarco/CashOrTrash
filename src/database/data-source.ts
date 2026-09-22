import 'reflect-metadata';

import { DataSource } from 'typeorm';
import { join } from 'node:path';

import { databaseConfig } from '../config/configuration';
import { databasePoolOptions } from './pool-options';

const database = databaseConfig();

/** CLI data source for generating, running, and reverting schema migrations. */
export default new DataSource({
  type: 'postgres',
  host: database.host,
  port: database.port,
  username: database.username,
  password: database.password,
  database: database.database,
  ssl: database.ssl ? { rejectUnauthorized: false } : false,
  // The same pool limits as the app, so a migration run from the CLI behaves
  // as it will at boot — the slow ones lift the statement timeout themselves.
  extra: databasePoolOptions(database),
  entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
  migrationsRun: false,
  synchronize: false,
});
