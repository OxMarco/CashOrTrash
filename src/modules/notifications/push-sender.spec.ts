import { ConfigService } from '@nestjs/config';

import { PushPlatform, PushToken } from './entities/push-token.entity';
import { ExpoPushSender } from './push-sender';

const token = (value: string): PushToken =>
  ({ token: value, platform: PushPlatform.IOS }) as PushToken;

/** Expo's own per-request message limit, which `send` batches at. */
const EXPO_BATCH = 100;

describe('ExpoPushSender', () => {
  const fetchMock = jest.fn();
  let sender: ExpoPushSender;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(global, 'fetch').mockImplementation(fetchMock);
    const config = {
      getOrThrow: jest.fn().mockReturnValue({ timeoutMs: 5_000 }),
    } as unknown as ConfigService;
    sender = new ExpoPushSender(config);
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends Expo-compatible payloads and removes rejected device tokens', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { status: 'ok', id: 'ticket-1' },
            { status: 'error', details: { error: 'DeviceNotRegistered' } },
          ],
        }),
    });

    await expect(
      sender.send([token('valid'), token('expired')], {
        title: 'Daily ready',
        body: 'Five items are waiting.',
        data: { kind: 'daily_ready' },
      }),
    ).resolves.toEqual({ sent: 1, invalidTokens: ['expired'], failed: 0 });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://exp.host/--/api/v2/push/send',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify([
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
        ]),
      }),
    );
  });

  it('batches requests at Expo’s 100-message limit', async () => {
    fetchMock.mockImplementation((_url: string, options: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: (JSON.parse(options.body as string) as unknown[]).map(() => ({
              status: 'ok',
            })),
          }),
      }),
    );

    const tokens = Array.from({ length: 101 }, (_, index) =>
      token(`token-${index}`),
    );
    await expect(
      sender.send(tokens, { title: 'Title', body: 'Body', data: {} }),
    ).resolves.toEqual({ sent: 101, invalidTokens: [], failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /**
   * The batches are separate requests, so the ones before a failure have
   * already been delivered. Throwing would discard that and let the job retry
   * re-notify every device it had already reached — the duplicate push being
   * worse than the missed one.
   */
  it('keeps what a failing batch already delivered, and counts the rest', async () => {
    const ok = (count: number) => ({
      ok: true,
      json: () =>
        Promise.resolve({
          data: Array.from({ length: count }, () => ({ status: 'ok' })),
        }),
    });

    fetchMock
      .mockResolvedValueOnce(ok(EXPO_BATCH))
      .mockResolvedValueOnce({ ok: false, status: 503 });

    const tokens = Array.from({ length: EXPO_BATCH + 1 }, (_, index) =>
      token(`token-${index}`),
    );

    await expect(
      sender.send(tokens, { title: 'Title', body: 'Body', data: {} }),
    ).resolves.toEqual({ sent: EXPO_BATCH, invalidTokens: [], failed: 1 });
  });

  it('counts a malformed ticket list rather than unwinding the call', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });

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
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { status: 'error', details: { error: 'MessageRateExceeded' } },
          ],
        }),
    });

    await expect(
      sender.send([token('one')], { title: 'Title', body: 'Body', data: {} }),
    ).resolves.toEqual({ sent: 0, invalidTokens: [], failed: 1 });
  });
});
