import Redis from 'ioredis';
import { Repository } from 'typeorm';

import { GameSession } from '../sessions/entities/game-session.entity';
import { User } from '../users/entities/user.entity';
import { PushPlatform, PushToken } from './entities/push-token.entity';
import { NotificationsService } from './notifications.service';

/** 19:00 local for offset 0 — the nudge hour for UTC devices. */
const NUDGE_TIME = new Date('2026-09-22T19:00:00Z');
const MINUTE = 60 * 1000;

const device = (id: number, userId: number, locale = 'en'): PushToken =>
  ({
    id,
    userId,
    token: `ExponentPushToken[${id}]`,
    platform: PushPlatform.IOS,
    timezoneOffsetMinutes: 0,
    locale,
    active: true,
  }) as PushToken;

const player = (id: number, streakDays = 0): User =>
  ({ id, streakDays, streakLastPlayedOn: '2026-09-21' }) as unknown as User;

/** Just enough of a Redis hash for the ticket stash. */
const fakeRedis = () => {
  const hash = new Map<string, string>();
  interface Multi {
    hset: jest.Mock;
    pexpire: jest.Mock;
    exec: jest.Mock;
  }
  const multi: Multi = {
    hset: jest.fn((_key: string, entries: Record<string, string>): Multi => {
      for (const [field, value] of Object.entries(entries)) {
        hash.set(field, value);
      }
      return multi;
    }),
    pexpire: jest.fn((): Multi => multi),
    exec: jest.fn(() => Promise.resolve([])),
  };
  return {
    hash,
    multi: jest.fn(() => multi),
    hgetall: jest.fn(() => Promise.resolve(Object.fromEntries(hash))),
    hdel: jest.fn((_key: string, ...fields: string[]) => {
      for (const field of fields) hash.delete(field);
      return Promise.resolve(fields.length);
    }),
  };
};

describe('NotificationsService', () => {
  let tokens: { find: jest.Mock; update: jest.Mock };
  let users: { find: jest.Mock };
  let sessions: { find: jest.Mock };
  let sender: { send: jest.Mock; receipts: jest.Mock };
  let redis: ReturnType<typeof fakeRedis>;
  let service: NotificationsService;

  beforeEach(() => {
    tokens = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(undefined),
    };
    users = { find: jest.fn().mockResolvedValue([]) };
    sessions = { find: jest.fn().mockResolvedValue([]) };
    sender = {
      send: jest.fn().mockResolvedValue({
        sent: 0,
        invalidTokens: [],
        failed: 0,
        tickets: [],
      }),
      receipts: jest
        .fn()
        .mockResolvedValue({ settled: [], deviceNotRegistered: [], failed: 0 }),
    };
    redis = fakeRedis();
    service = new NotificationsService(
      tokens as unknown as Repository<PushToken>,
      users as unknown as Repository<User>,
      sessions as unknown as Repository<GameSession>,
      sender,
      redis as unknown as Redis,
    );
  });

  const retired = () =>
    tokens.update.mock.calls.map(
      ([where]) => (where as { token: { _value: string[] } }).token._value,
    );

  describe('sending the daily nudge', () => {
    it('asks only for devices whose local time is the nudge hour', async () => {
      // 12:00 UTC is 19:00 at UTC+7, and nowhere else.
      await expect(
        service.sendDailyNudges(new Date('2026-09-22T12:00:00Z')),
      ).resolves.toBe(0);
      const [{ where }] = tokens.find.mock.calls[0] as [
        { where: { timezoneOffsetMinutes: { _value: number[] } } },
      ];
      expect(where.timezoneOffsetMinutes._value).toEqual([420, 435, 450, 465]);
      expect(sender.send).not.toHaveBeenCalled();
    });

    /**
     * The point of the rewrite. Every player's messages go to the sender in
     * one call, which batches at Expo's limit — rather than one request per
     * player, in series, for the whole sweep.
     */
    it('hands the whole sweep to the sender in one call', async () => {
      const devices = Array.from({ length: 250 }, (_, index) =>
        device(index + 1, index + 1),
      );
      tokens.find.mockResolvedValue(devices);
      users.find.mockResolvedValue(devices.map(({ userId }) => player(userId)));
      sender.send.mockResolvedValue({
        sent: 250,
        invalidTokens: [],
        failed: 0,
        tickets: [],
      });

      await expect(service.sendDailyNudges(NUDGE_TIME)).resolves.toBe(250);
      expect(sender.send).toHaveBeenCalledTimes(1);
      expect(sender.send.mock.calls[0][0]).toHaveLength(250);
    });

    it('writes each device in its own language', async () => {
      tokens.find.mockResolvedValue([device(1, 7, 'it'), device(2, 7, 'en')]);
      users.find.mockResolvedValue([player(7)]);

      await service.sendDailyNudges(NUDGE_TIME);

      const [deliveries] = sender.send.mock.calls[0] as [
        Array<{ token: PushToken; message: { title: string } }>,
      ];
      expect(deliveries.map(({ token }) => token.locale)).toEqual(['it', 'en']);
      expect(deliveries[0].message.title).not.toBe(deliveries[1].message.title);
    });

    it('skips a player who has played and has no streak at risk', async () => {
      tokens.find.mockResolvedValue([device(1, 7)]);
      users.find.mockResolvedValue([player(7)]);
      sessions.find.mockResolvedValue([{ userId: 7 }]);

      await expect(service.sendDailyNudges(NUDGE_TIME)).resolves.toBe(0);
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('retires the devices the tickets say are gone, in one write', async () => {
      tokens.find.mockResolvedValue([device(1, 7), device(2, 8)]);
      users.find.mockResolvedValue([player(7), player(8)]);
      sender.send.mockResolvedValue({
        sent: 1,
        invalidTokens: ['ExponentPushToken[2]'],
        failed: 0,
        tickets: [{ id: 'ticket-1', token: 'ExponentPushToken[1]' }],
      });

      await service.sendDailyNudges(NUDGE_TIME);

      expect(retired()).toEqual([['ExponentPushToken[2]']]);
    });

    it('keeps the accepted tickets for the receipt check', async () => {
      tokens.find.mockResolvedValue([device(1, 7)]);
      users.find.mockResolvedValue([player(7)]);
      sender.send.mockResolvedValue({
        sent: 1,
        invalidTokens: [],
        failed: 0,
        tickets: [{ id: 'ticket-1', token: 'ExponentPushToken[1]' }],
      });

      await service.sendDailyNudges(NUDGE_TIME);

      expect(JSON.parse(redis.hash.get('ticket-1') ?? 'null')).toEqual({
        token: 'ExponentPushToken[1]',
        sentAt: NUDGE_TIME.getTime(),
      });
    });

    /**
     * A thrown send must not fail the job: a retry would resend the whole
     * sweep, and whatever the sender had already delivered would go twice.
     */
    it('swallows a sender that throws rather than failing the job', async () => {
      tokens.find.mockResolvedValue([device(1, 7)]);
      users.find.mockResolvedValue([player(7)]);
      sender.send.mockRejectedValue(new Error('boom'));

      await expect(service.sendDailyNudges(NUDGE_TIME)).resolves.toBe(0);
    });

    it('still reports the sweep when the ticket stash is unavailable', async () => {
      tokens.find.mockResolvedValue([device(1, 7)]);
      users.find.mockResolvedValue([player(7)]);
      sender.send.mockResolvedValue({
        sent: 1,
        invalidTokens: [],
        failed: 0,
        tickets: [{ id: 'ticket-1', token: 'ExponentPushToken[1]' }],
      });
      redis.multi.mockImplementation(() => {
        throw new Error('READONLY');
      });

      await expect(service.sendDailyNudges(NUDGE_TIME)).resolves.toBe(1);
    });
  });

  describe('checking push receipts', () => {
    const stash = (id: string, token: string, minutesAgo: number) =>
      redis.hash.set(
        id,
        JSON.stringify({
          token,
          sentAt: NUDGE_TIME.getTime() - minutesAgo * MINUTE,
        }),
      );

    it('retires the devices whose receipt says DeviceNotRegistered', async () => {
      stash('t-live', 'tok-live', 30);
      stash('t-dead', 'tok-dead', 30);
      sender.receipts.mockResolvedValue({
        settled: ['t-live', 't-dead'],
        deviceNotRegistered: ['t-dead'],
        failed: 0,
      });

      await expect(service.checkPushReceipts(NUDGE_TIME)).resolves.toEqual({
        checked: 2,
        retired: 1,
      });
      expect(retired()).toEqual([['tok-dead']]);
      expect(redis.hash.size).toBe(0);
    });

    it('waits for a ticket to be old enough to have a receipt', async () => {
      stash('t-fresh', 'tok', 5);
      await service.checkPushReceipts(NUDGE_TIME);
      expect(sender.receipts).not.toHaveBeenCalled();
      expect(redis.hash.has('t-fresh')).toBe(true);
    });

    it('keeps a ticket Expo has not answered yet, to ask again', async () => {
      stash('t-slow', 'tok', 30);
      sender.receipts.mockResolvedValue({
        settled: [],
        deviceNotRegistered: [],
        failed: 0,
      });
      await service.checkPushReceipts(NUDGE_TIME);
      expect(redis.hash.has('t-slow')).toBe(true);
    });

    it('drops a ticket past the day Expo keeps receipts for', async () => {
      stash('t-old', 'tok', 25 * 60);
      redis.hash.set('t-garbage', 'not json');
      await service.checkPushReceipts(NUDGE_TIME);
      expect(sender.receipts).not.toHaveBeenCalled();
      expect(redis.hash.size).toBe(0);
    });
  });
});
