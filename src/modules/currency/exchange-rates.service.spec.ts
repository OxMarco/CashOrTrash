import { ConfigService } from '@nestjs/config';
import { Cache } from 'cache-manager';

import { ExchangeRatesService } from './exchange-rates.service';

const CONFIG = {
  apiUrl: 'https://rates.test/latest',
  refreshSeconds: 3_600,
  timeoutMs: 500,
  fallbackRates: { EUR: 0.92, GBP: 0.79 },
};

const okResponse = (rates: Record<string, number>, date = '2026-08-03') => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ amount: 1, base: 'USD', date, rates }),
});

const build = (cache: Partial<Record<keyof Cache, unknown>> = {}) =>
  new ExchangeRatesService(
    {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(undefined),
      ...cache,
    } as unknown as Cache,
    { getOrThrow: () => CONFIG } as unknown as ConfigService,
  );

describe('ExchangeRatesService', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('serves the configured fallback before any fetch has landed', () => {
    // A cold process must be able to deal a round, not wait on a third party.
    expect(build().current()).toEqual({
      rates: { USD: 1, EUR: 0.92, GBP: 0.79 },
      asOf: new Date(0).toISOString(),
      live: false,
    });
  });

  it('publishes live rates once a fetch succeeds', async () => {
    fetchMock.mockResolvedValue(okResponse({ EUR: 0.86693, GBP: 0.74238 }));
    const service = build();

    await service.refresh();

    expect(service.current()).toEqual({
      rates: { USD: 1, EUR: 0.86693, GBP: 0.74238 },
      asOf: '2026-08-03T00:00:00.000Z',
      live: true,
    });
  });

  it('asks the provider for every supported currency against the dollar', async () => {
    fetchMock.mockResolvedValue(okResponse({ EUR: 0.86, GBP: 0.74 }));

    await build().refresh();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://rates.test/latest?base=USD&symbols=EUR,GBP',
      expect.anything(),
    );
  });

  it('pins the dollar to 1 whatever the provider says', async () => {
    fetchMock.mockResolvedValue(okResponse({ EUR: 0.86, GBP: 0.74, USD: 3 }));
    const service = build();

    await service.refresh();

    expect(service.current().rates.USD).toBe(1);
  });

  it.each([
    ['a currency is missing', { EUR: 0.86 }],
    ['a rate is not a number', { EUR: 0.86, GBP: 'cheap' }],
    ['a rate is implausible', { EUR: 0.86, GBP: 0 }],
  ])('keeps the previous rates when %s', async (_label, rates) => {
    fetchMock.mockResolvedValueOnce(okResponse({ EUR: 0.86, GBP: 0.74 }));
    const service = build();
    await service.refresh();

    fetchMock.mockResolvedValueOnce(
      okResponse(rates as Record<string, number>),
    );
    await service.refresh();

    // Half-updated rates would price two items in the same round differently,
    // so a bad payload is rejected whole rather than merged.
    expect(service.current().rates).toEqual({ USD: 1, EUR: 0.86, GBP: 0.74 });
  });

  it('survives an unreachable provider', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const service = build();

    await expect(service.refresh()).resolves.toEqual(service.current());
    expect(service.current().live).toBe(false);
  });

  it('survives an error status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: () => ({}) });
    const service = build();

    await service.refresh();

    expect(service.current().live).toBe(false);
  });

  it('starts on the shared cached snapshot rather than the fallback', async () => {
    const cached = {
      rates: { USD: 1, EUR: 0.81, GBP: 0.71 },
      asOf: '2026-08-02T00:00:00.000Z',
      live: true,
    };
    fetchMock.mockRejectedValue(new Error('down'));
    const service = build({ get: () => Promise.resolve(cached) });

    await service.onModuleInit();
    service.onModuleDestroy();

    // A replica restarting mid-day carries on with what its siblings are using
    // instead of repricing every round back to the fallback.
    expect(service.current()).toEqual(cached);
  });

  it('does not block boot on the provider', async () => {
    let settle: () => void = () => undefined;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        settle = () => resolve(okResponse({ EUR: 0.86, GBP: 0.74 }));
      }),
    );
    const service = build();

    await service.onModuleInit();
    expect(service.current().live).toBe(false);

    settle();
    service.onModuleDestroy();
  });
});
