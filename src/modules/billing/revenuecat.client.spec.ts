import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NEVER_EXPIRES } from './entitlement';
import { RevenueCatClient } from './revenuecat.client';

const CONFIG = {
  revenueCatSecretKey: 'sk_test',
  revenueCatWebhookAuth: '',
  revenueCatApiUrl: 'https://rc.test/v1',
  revenueCatTimeoutMs: 500,
  entitlementId: 'premium',
  freeQuickRoundsPerDay: 5,
};

const build = (overrides: Partial<typeof CONFIG> = {}) =>
  new RevenueCatClient({
    getOrThrow: () => ({ ...CONFIG, ...overrides }),
  } as unknown as ConfigService);

const subscriber = (entitlements: Record<string, unknown>, status = 200) => ({
  ok: status < 400,
  status,
  json: () => Promise.resolve({ subscriber: { entitlements } }),
});

describe('RevenueCatClient', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  it('reads the entitlement expiry with the secret key', async () => {
    fetchMock.mockResolvedValue(
      subscriber({ premium: { expires_date: '2026-10-01T00:00:00Z' } }),
    );

    await expect(build().entitlementExpiry('abc')).resolves.toEqual(
      new Date('2026-10-01T00:00:00Z'),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://rc.test/v1/subscribers/abc',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer sk_test' }),
      }),
    );
  });

  // The store is still retrying the card; the player has done nothing to lose
  // access over.
  it('counts a billing grace period as paid', async () => {
    fetchMock.mockResolvedValue(
      subscriber({
        premium: {
          expires_date: '2026-10-01T00:00:00Z',
          grace_period_expires_date: '2026-10-17T00:00:00Z',
        },
      }),
    );

    await expect(build().entitlementExpiry('abc')).resolves.toEqual(
      new Date('2026-10-17T00:00:00Z'),
    );
  });

  it('stores an entitlement with no end as never expiring', async () => {
    fetchMock.mockResolvedValue(
      subscriber({ premium: { expires_date: null } }),
    );
    await expect(build().entitlementExpiry('abc')).resolves.toBe(NEVER_EXPIRES);
  });

  it('reads a customer without the entitlement as free', async () => {
    fetchMock.mockResolvedValue(
      subscriber({ other: { expires_date: '2099-01-01T00:00:00Z' } }),
    );
    await expect(build().entitlementExpiry('abc')).resolves.toBeNull();
  });

  // A failure must surface, not read as "free": the webhook answers 5xx on it
  // and RevenueCat retries, where a silent null would revoke a paying player.
  it('throws on an error response rather than reading it as free', async () => {
    fetchMock.mockResolvedValue(subscriber({}, 500));
    await expect(build().entitlementExpiry('abc')).rejects.toThrow('500');
  });

  it('treats a customer RevenueCat no longer has as already deleted', async () => {
    fetchMock.mockResolvedValue(subscriber({}, 404));
    await expect(build().deleteCustomer('abc')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://rc.test/v1/subscribers/abc',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('refuses to call out without a key', async () => {
    await expect(
      build({ revenueCatSecretKey: '' }).entitlementExpiry('abc'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
