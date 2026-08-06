import { RedisConfig } from 'src/config/configuration';

import { buildBullRedisOptions, buildRedisOptions } from './redis.module';

describe('Redis connection options', () => {
  const config: RedisConfig = {
    host: 'redis.internal',
    port: 6380,
    password: 'secret',
    db: 2,
  };

  it('bounds retries and command duration on request-path clients', () => {
    expect(buildRedisOptions(config)).toEqual(
      expect.objectContaining({
        maxRetriesPerRequest: 2,
        commandTimeout: 2_000,
        connectTimeout: 5_000,
      }),
    );
  });

  it('uses BullMQ-compatible retries only for queue connections', () => {
    const options = buildBullRedisOptions(config);

    expect(options.maxRetriesPerRequest).toBeNull();
    expect(options.commandTimeout).toBeUndefined();
  });
});
