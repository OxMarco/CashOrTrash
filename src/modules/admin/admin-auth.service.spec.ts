import { Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { AdminAuthService } from './admin-auth.service';
import { hashAdminPassword } from './admin-password';

/**
 * The login budget has to hold against a parallel guessing run, which is the
 * case a check-then-record budget missed: every concurrent guess read the same
 * count before any of them was charged.
 */
describe('AdminAuthService login budget', () => {
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await hashAdminPassword('correct horse');
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  /** A stand-in for the counter that behaves like Redis: one INCR at a time. */
  const makeRedis = () => {
    const counters = new Map<string, number>();
    const expiries = new Map<string, number>();
    const redis = {
      counters,
      expiries,
      del: jest.fn((key: string) => {
        counters.delete(key);
        expiries.delete(key);
        return Promise.resolve(1);
      }),
      multi: jest.fn(() => {
        const ops: Array<() => [null, unknown]> = [];
        const chain = {
          incr: (key: string) => {
            ops.push(() => {
              const next = (counters.get(key) ?? 0) + 1;
              counters.set(key, next);
              return [null, next];
            });
            return chain;
          },
          expire: (key: string, seconds: number, mode: string) => {
            ops.push(() => {
              if (mode === 'NX' && expiries.has(key)) return [null, 0];
              expiries.set(key, seconds);
              return [null, 1];
            });
            return chain;
          },
          exec: () => Promise.resolve(ops.map((op) => op())),
        };
        return chain;
      }),
    };
    return redis;
  };

  const makeService = (redis: ReturnType<typeof makeRedis>) =>
    new AdminAuthService(
      { signAsync: jest.fn().mockResolvedValue('admin-token') } as never,
      redis as unknown as Redis,
      {
        getOrThrow: () => ({
          passwordHash,
          jwtSecret: 'secret',
          sessionTtl: '1h',
        }),
      } as unknown as ConfigService,
    );

  it('refuses the eleventh concurrent guess even though none has finished', async () => {
    const redis = makeRedis();
    const service = makeService(redis);

    const results = await Promise.allSettled(
      Array.from({ length: 11 }, () => service.login('guess', '198.51.100.7')),
    );

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(redis.counters.get('admin:login:198.51.100.7')).toBe(11);
    // Now even the right password is refused from this address.
    await expect(
      service.login('correct horse', '198.51.100.7'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('opens the window once and never pushes it out', async () => {
    const redis = makeRedis();
    const service = makeService(redis);

    await service.login('guess', '198.51.100.7').catch(() => undefined);
    redis.expiries.set('admin:login:198.51.100.7', 42);
    await service.login('guess', '198.51.100.7').catch(() => undefined);

    expect(redis.expiries.get('admin:login:198.51.100.7')).toBe(42);
  });

  it('clears the address’s count on a successful login', async () => {
    const redis = makeRedis();
    const service = makeService(redis);

    await service.login('guess', '198.51.100.7').catch(() => undefined);
    await expect(service.login('correct horse', '198.51.100.7')).resolves.toBe(
      'admin-token',
    );

    expect(redis.del).toHaveBeenCalledWith('admin:login:198.51.100.7');
    expect(redis.counters.has('admin:login:198.51.100.7')).toBe(false);
  });

  it('does not budget a request with no address', async () => {
    const redis = makeRedis();

    await expect(makeService(redis).login('correct horse', null)).resolves.toBe(
      'admin-token',
    );
    expect(redis.multi).not.toHaveBeenCalled();
  });
});
