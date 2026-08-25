import { QueryRunner } from 'typeorm';

import {
  INITIAL_SCHEMA_COLUMNS,
  shouldCreateInitialSchema,
} from './initial-schema-baseline';

type Schema = Record<string, readonly string[]>;

const runnerFor = (schema: Schema): QueryRunner =>
  ({
    hasTable: jest.fn((name: string) => Promise.resolve(name in schema)),
    getTable: jest.fn((name: string) =>
      Promise.resolve(
        name in schema
          ? { columns: schema[name].map((column) => ({ name: column })) }
          : undefined,
      ),
    ),
  }) as unknown as QueryRunner;

describe('initial migration baseline', () => {
  it('creates the schema in an empty database', async () => {
    await expect(shouldCreateInitialSchema(runnerFor({}))).resolves.toBe(true);
  });

  it('baselines the complete schema left by synchronize', async () => {
    await expect(
      shouldCreateInitialSchema(runnerFor(INITIAL_SCHEMA_COLUMNS)),
    ).resolves.toBe(false);
  });

  it('refuses to bless a partial schema', async () => {
    const { daily_score: _missing, ...partial } = INITIAL_SCHEMA_COLUMNS;

    await expect(shouldCreateInitialSchema(runnerFor(partial))).rejects.toThrow(
      'missing tables: daily_score',
    );
  });

  it('refuses an older table that is missing a required column', async () => {
    const schema: Schema = {
      ...INITIAL_SCHEMA_COLUMNS,
      user: INITIAL_SCHEMA_COLUMNS.user.filter(
        (column) => column !== 'registrationIp',
      ),
    };

    await expect(shouldCreateInitialSchema(runnerFor(schema))).rejects.toThrow(
      'user is missing columns: registrationIp',
    );
  });
});
