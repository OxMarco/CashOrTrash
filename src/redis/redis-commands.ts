import Redis from 'ioredis';

const RESERVE_DISTINCT_DEVICE = `
  if redis.call('sismember', KEYS[1], ARGV[1]) == 1 then
    redis.call('expire', KEYS[1], ARGV[3])
    return 1
  end
  if redis.call('scard', KEYS[1]) >= tonumber(ARGV[2]) then
    return 0
  end
  redis.call('sadd', KEYS[1], ARGV[1])
  redis.call('expire', KEYS[1], ARGV[3])
  return 1
`;

const ACQUIRE_SOCKET_CONNECTION = `
  redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
  if redis.call('zcard', KEYS[1]) >= tonumber(ARGV[2]) then
    return 0
  end
  redis.call('zadd', KEYS[1], ARGV[3], ARGV[4])
  redis.call('expire', KEYS[1], ARGV[5])
  return 1
`;

const DELETE_IF_VALUE = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  end
  return 0
`;

export type AppRedis = Redis & {
  reserveDistinctDevice(
    key: string,
    deviceDigest: string,
    limit: number,
    ttlSeconds: number,
  ): Promise<number>;
  acquireSocketConnection(
    key: string,
    now: number,
    limit: number,
    expiresAt: number,
    member: string,
    ttlSeconds: number,
  ): Promise<number>;
  deleteIfValue(key: string, expectedValue: string): Promise<number>;
};

/**
 * Registers the application's atomic operations once per client. ioredis then
 * loads and invokes them with EVALSHA, falling back to EVAL when Redis has not
 * seen the script yet.
 */
export const defineRedisCommands = (redis: Redis): AppRedis => {
  redis.defineCommand('reserveDistinctDevice', {
    numberOfKeys: 1,
    lua: RESERVE_DISTINCT_DEVICE,
  });
  redis.defineCommand('acquireSocketConnection', {
    numberOfKeys: 1,
    lua: ACQUIRE_SOCKET_CONNECTION,
  });
  redis.defineCommand('deleteIfValue', {
    numberOfKeys: 1,
    lua: DELETE_IF_VALUE,
  });
  return redis as AppRedis;
};
