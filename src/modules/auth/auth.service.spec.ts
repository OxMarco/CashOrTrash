import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerException } from '@nestjs/throttler';

import { AppRedis } from 'src/redis/redis-commands';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

describe('AuthService account-minting budget', () => {
  const user = { id: 7, username: null };
  let users: {
    findByDeviceId: jest.Mock;
    findOrCreateByDeviceId: jest.Mock;
  };
  let redis: { reserveDistinctDevice: jest.Mock };
  let service: AuthService;

  beforeEach(() => {
    users = {
      findByDeviceId: jest.fn().mockResolvedValue(null),
      findOrCreateByDeviceId: jest
        .fn()
        .mockResolvedValue({ user, created: true }),
    };
    redis = { reserveDistinctDevice: jest.fn().mockResolvedValue(1) };
    const config = {
      getOrThrow: (key: string) =>
        key === 'auth'
          ? {
              accessSecret: 'secret',
              accessTtl: '15m',
            }
          : { accountsPerIpPerDay: 2 },
    };

    service = new AuthService(
      users as unknown as UsersService,
      {
        signAsync: jest.fn().mockResolvedValue('token'),
      } as unknown as JwtService,
      redis as unknown as AppRedis,
      config as unknown as ConfigService,
    );
  });

  it('reserves a stable device digest atomically', async () => {
    await service.authenticateDevice('same-device', '203.0.113.9');
    await service.authenticateDevice('same-device', '203.0.113.9');

    expect(redis.reserveDistinctDevice).toHaveBeenCalledTimes(2);
    expect(redis.reserveDistinctDevice.mock.calls[0]).toEqual(
      redis.reserveDistinctDevice.mock.calls[1],
    );
    const [key, digest, limit, ttl] = redis.reserveDistinctDevice.mock.calls[0];
    expect(key).toMatch(/^auth:mintset:203\.0\.113\.9:\d{4}-\d{2}-\d{2}$/);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain('same-device');
    expect(limit).toBe(2);
    expect(ttl).toBe(86_400);
  });

  it('rejects a new distinct device when the atomic reservation refuses it', async () => {
    redis.reserveDistinctDevice.mockResolvedValue(0);

    await expect(
      service.authenticateDevice('new-device', '203.0.113.9'),
    ).rejects.toBeInstanceOf(ThrottlerException);
    expect(users.findOrCreateByDeviceId).not.toHaveBeenCalled();
  });

  it('does not charge returning devices', async () => {
    users.findByDeviceId.mockResolvedValue(user);

    const result = await service.authenticateDevice(
      'returning-device',
      '203.0.113.9',
    );

    expect(redis.reserveDistinctDevice).not.toHaveBeenCalled();
    expect(result.isNewPlayer).toBe(false);
  });

  it('keeps onboarding available when Redis is down', async () => {
    redis.reserveDistinctDevice.mockRejectedValue(new Error('offline'));

    const result = await service.authenticateDevice(
      'new-device',
      '203.0.113.9',
    );

    expect(result.isNewPlayer).toBe(true);
    expect(users.findOrCreateByDeviceId).toHaveBeenCalled();
  });
});
