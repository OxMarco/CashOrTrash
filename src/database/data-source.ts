import 'reflect-metadata';

import { DataSource } from 'typeorm';
import { join } from 'node:path';

import { databaseConfig } from '../config/configuration';

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
  entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
  migrationsRun: false,
  synchronize: false,
});
