import { Logger } from '@nestjs/common';

import { SchemaExtras } from './schema-extras';

describe('schema extras', () => {
  afterEach(() => jest.restoreAllMocks());

  it('refuses startup when a required database invariant cannot be installed', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const failure = new Error('permission denied for schema public');
    const dataSource = { query: jest.fn().mockRejectedValue(failure) } as never;

    await expect(
      new SchemaExtras(dataSource).onApplicationBootstrap(),
    ).rejects.toBe(failure);
  });
});
