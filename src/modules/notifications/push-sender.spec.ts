import { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';

import { PushPlatform, PushToken } from './entities/push-token.entity';
import { ExpoGateway, ExpoPushSender } from './push-sender';

const token = (value: string): PushToken =>
  ({ token: value, platform: PushPlatform.IOS }) as PushToken;

/** Expo's own per-request message limit, which `send` batches at. */
const EXPO_BATCH = 100;

describe('ExpoPushSender', () => {
  let expo: { chunk: jest.Mock; send: jest.Mock };
  let sender: ExpoPushSender;

  beforeEach(() => {
    expo = {
      chunk: jest.fn((messages: ExpoPushMessage[]) =>
        Array.from(
          { length: Math.ceil(messages.length / EXPO_BATCH) },
          (_, index) =>
            messages.slice(index * EXPO_BATCH, (index + 1) * EXPO_BATCH),
        ),
      ),
      send: jest.fn(),
    };
    sender = new ExpoPushSender(expo as unknown as ExpoGateway);
  });

  it('sends Expo-compatible payloads and removes rejected device tokens', async () => {
    expo.send.mockResolvedValue([
      { status: 'ok', id: 'ticket-1' },
      {
        status: 'error',
        message: 'gone',
        details: { error: 'DeviceNotRegistered' },
      },
    ] satisfies ExpoPushTicket[]);

    await expect(
      sender.send([token('valid'), token('expired')], {
        title: 'Daily ready',
        body: 'Five items are waiting.',
        data: { kind: 'daily_ready' },
      }),
    ).resolves.toEqual({ sent: 1, invalidTokens: ['expired'], failed: 0 });

    expect(expo.send).toHaveBeenCalledWith([
      {
        to: 'valid',
        title: 'Daily ready',
        body: 'Five items are waiting.',
        data: { kind: 'daily_ready' },
        sound: 'default',
      },
      {
        to: 'expired',
        title: 'Daily ready',
        body: 'Five items are waiting.',
        data: { kind: 'daily_ready' },
        sound: 'default',
      },
    ]);
  });

  it('batches requests at Expo’s 100-message limit', async () => {
    expo.send.mockImplementation((messages: ExpoPushMessage[]) =>
      Promise.resolve(
        messages.map((_, index) => ({
          status: 'ok',
          id: `ticket-${index}`,
        })),
      ),
    );

    const tokens = Array.from({ length: 101 }, (_, index) =>
      token(`token-${index}`),
    );
    await expect(
      sender.send(tokens, { title: 'Title', body: 'Body', data: {} }),
    ).resolves.toEqual({ sent: 101, invalidTokens: [], failed: 0 });
    expect(expo.send).toHaveBeenCalledTimes(2);
  });

  /**
   * The batches are separate requests, so the ones before a failure have
   * already been delivered. Throwing would discard that and let the job retry
   * re-notify every device it had already reached — the duplicate push being
   * worse than the missed one.
   */
  it('keeps what a failing batch already delivered, and counts the rest', async () => {
    expo.send
      .mockResolvedValueOnce(
        Array.from({ length: EXPO_BATCH }, (_, index) => ({
          status: 'ok',
          id: `ticket-${index}`,
        })),
      )
      .mockRejectedValueOnce(new Error('503'));

    const tokens = Array.from({ length: EXPO_BATCH + 1 }, (_, index) =>
      token(`token-${index}`),
    );

    await expect(
      sender.send(tokens, { title: 'Title', body: 'Body', data: {} }),
    ).resolves.toEqual({ sent: EXPO_BATCH, invalidTokens: [], failed: 1 });
  });

  it('counts a malformed ticket list rather than unwinding the call', async () => {
    expo.send.mockResolvedValueOnce([]);

    await expect(
      sender.send([token('one')], { title: 'Title', body: 'Body', data: {} }),
    ).resolves.toEqual({ sent: 0, invalidTokens: [], failed: 1 });
  });

  /**
   * Neither delivered nor a dead device — a throttle, or an Expo-side fault.
   * It must not be mistaken for a token to retire: deactivating it would cost
   * the player every future notification over one bad minute.
   */
  it('counts an unrecognised ticket without retiring the token', async () => {
    expo.send.mockResolvedValueOnce([
      {
        status: 'error',
        message: 'slow down',
        details: { error: 'MessageRateExceeded' },
      },
    ] satisfies ExpoPushTicket[]);

    await expect(
      sender.send([token('one')], { title: 'Title', body: 'Body', data: {} }),
    ).resolves.toEqual({ sent: 0, invalidTokens: [], failed: 1 });
  });
});
