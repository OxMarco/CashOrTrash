import {
  ExpoPushMessage,
  ExpoPushReceipt,
  ExpoPushTicket,
} from 'expo-server-sdk';

import { PushPlatform, PushToken } from './entities/push-token.entity';
import {
  ExpoGateway,
  ExpoPushSender,
  type PushDelivery,
  type PushMessage,
} from './push-sender';

const token = (value: string): PushToken =>
  ({ token: value, platform: PushPlatform.IOS }) as PushToken;

/** The same message to each token — what most of these cases need. */
const to = (tokens: PushToken[], message: PushMessage): PushDelivery[] =>
  tokens.map((target) => ({ token: target, message }));

/** Expo's own per-request message limit, which `send` batches at. */
const EXPO_BATCH = 100;

describe('ExpoPushSender', () => {
  let expo: {
    chunk: jest.Mock;
    send: jest.Mock;
    chunkReceiptIds: jest.Mock;
    receipts: jest.Mock;
  };
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
      chunkReceiptIds: jest.fn((ids: string[]) => [ids]),
      receipts: jest.fn(),
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
      sender.send(
        to([token('valid'), token('expired')], {
          title: 'Daily ready',
          body: 'Five items are waiting.',
          data: { kind: 'daily_ready' },
        }),
      ),
    ).resolves.toEqual({
      sent: 1,
      invalidTokens: ['expired'],
      failed: 0,
      tickets: [{ id: 'ticket-1', token: 'valid' }],
    });

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
      sender.send(to(tokens, { title: 'Title', body: 'Body', data: {} })),
    ).resolves.toMatchObject({ sent: 101, invalidTokens: [], failed: 0 });
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
      sender.send(to(tokens, { title: 'Title', body: 'Body', data: {} })),
    ).resolves.toMatchObject({
      sent: EXPO_BATCH,
      invalidTokens: [],
      failed: 1,
    });
  });

  it('counts a malformed ticket list rather than unwinding the call', async () => {
    expo.send.mockResolvedValueOnce([]);

    await expect(
      sender.send(
        to([token('one')], { title: 'Title', body: 'Body', data: {} }),
      ),
    ).resolves.toEqual({ sent: 0, invalidTokens: [], failed: 1, tickets: [] });
  });

  /**
   * `chunkPushNotifications` owns how messages are packed, and nothing here
   * constrains it to emit them in the order they were handed over. Attributing
   * tickets by position would then retire whichever token happened to sit at
   * the dead one's index — deactivating a live device and leaving the dead one
   * to fail again on every future send.
   */
  it('retires the token the ticket belongs to when Expo reorders a chunk', async () => {
    expo.chunk.mockImplementation((messages: ExpoPushMessage[]) => [
      [...messages].reverse(),
    ]);
    expo.send.mockResolvedValueOnce([
      {
        status: 'error',
        message: 'gone',
        details: { error: 'DeviceNotRegistered' },
      },
      { status: 'ok', id: 'ticket-1' },
    ] satisfies ExpoPushTicket[]);

    // Reversed, so the dead ticket is first while `expired` was passed second.
    await expect(
      sender.send(
        to([token('valid'), token('expired')], {
          title: 'Title',
          body: 'Body',
          data: {},
        }),
      ),
    ).resolves.toEqual({
      sent: 1,
      invalidTokens: ['expired'],
      failed: 0,
      tickets: [{ id: 'ticket-1', token: 'valid' }],
    });
  });

  it('attributes no ticket in a chunk it cannot trace back to a token', async () => {
    expo.chunk.mockImplementation(() => [
      [{ to: 'never-registered', title: 'Title', body: 'Body' }],
    ]);

    await expect(
      sender.send(
        to([token('one')], { title: 'Title', body: 'Body', data: {} }),
      ),
    ).resolves.toEqual({ sent: 0, invalidTokens: [], failed: 1, tickets: [] });
    expect(expo.send).not.toHaveBeenCalled();
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
      sender.send(
        to([token('one')], { title: 'Title', body: 'Body', data: {} }),
      ),
    ).resolves.toEqual({ sent: 0, invalidTokens: [], failed: 1, tickets: [] });
  });

  it('sends each device its own message in one batch', async () => {
    expo.send.mockImplementation((messages: ExpoPushMessage[]) =>
      Promise.resolve(
        messages.map((_, index) => ({ status: 'ok', id: `t-${index}` })),
      ),
    );

    await sender.send([
      { token: token('en'), message: { title: 'Ready', body: 'Play' } },
      { token: token('it'), message: { title: 'Pronto', body: 'Gioca' } },
    ]);

    expect(expo.send).toHaveBeenCalledTimes(1);
    expect(expo.send).toHaveBeenCalledWith([
      expect.objectContaining({ to: 'en', title: 'Ready' }),
      expect.objectContaining({ to: 'it', title: 'Pronto' }),
    ]);
  });

  describe('receipts', () => {
    it('settles every id Expo answered and names the dead devices', async () => {
      expo.receipts.mockResolvedValueOnce({
        a: { status: 'ok' },
        b: {
          status: 'error',
          message: 'gone',
          details: { error: 'DeviceNotRegistered' },
        },
        c: {
          status: 'error',
          message: 'apns down',
          details: { error: 'ProviderError' },
        },
      } satisfies Record<string, ExpoPushReceipt>);

      await expect(sender.receipts(['a', 'b', 'c', 'd'])).resolves.toEqual({
        // `d` has no receipt yet, so it is not settled and will be asked again.
        settled: ['a', 'b', 'c'],
        deviceNotRegistered: ['b'],
        failed: 1,
      });
    });

    it('leaves a chunk it could not fetch unsettled, to ask again', async () => {
      expo.chunkReceiptIds.mockReturnValueOnce([['a'], ['b']]);
      expo.receipts
        .mockRejectedValueOnce(new Error('503'))
        .mockResolvedValueOnce({ b: { status: 'ok' } });

      await expect(sender.receipts(['a', 'b'])).resolves.toEqual({
        settled: ['b'],
        deviceNotRegistered: [],
        failed: 0,
      });
    });
  });
});
