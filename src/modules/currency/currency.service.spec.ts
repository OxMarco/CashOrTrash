import { CurrencyService } from './currency.service';
import { ExchangeRatesService, RateSnapshot } from './exchange-rates.service';

const snapshot = (
  rates: Partial<RateSnapshot['rates']> = {},
): RateSnapshot => ({
  rates: { USD: 1, EUR: 0.92, GBP: 0.79, ...rates },
  asOf: '2026-08-03T00:00:00.000Z',
  live: true,
});

const build = (rates?: Partial<RateSnapshot['rates']>): CurrencyService =>
  new CurrencyService({
    current: () => snapshot(rates),
  } as unknown as ExchangeRatesService);

describe('CurrencyService', () => {
  let service: CurrencyService;

  beforeEach(() => {
    service = build();
  });

  it('leaves dollars alone in both directions', () => {
    // Not merely "the rate is 1": USD is the stored unit, so the conversion is
    // skipped outright and cannot be perturbed by a rounding rule.
    expect(service.fromUsdCents(45_000, 'USD')).toBe(45_000);
    expect(service.toUsdCents(45_000, 'USD')).toBe(45_000);
    expect(service.rateFor('USD')).toBe(1);
  });

  it('converts a stored dollar price into the player’s currency', () => {
    expect(service.fromUsdCents(45_000, 'EUR')).toBe(41_400);
    expect(service.fromUsdCents(45_000, 'GBP')).toBe(35_550);
  });

  it('converts a bet back into the dollars scoring works in', () => {
    expect(service.toUsdCents(41_400, 'EUR')).toBe(45_000);
    expect(service.toUsdCents(35_550, 'GBP')).toBe(45_000);
  });

  it('follows the rate that is in force now', () => {
    // The rate is live, so the same price is a different number tomorrow. What
    // must not happen is a stale one being baked in anywhere.
    expect(build({ EUR: 0.5 }).fromUsdCents(10_000, 'EUR')).toBe(5_000);
    expect(build({ EUR: 1.25 }).fromUsdCents(10_000, 'EUR')).toBe(12_500);
  });

  it('round-trips a price to within a minor unit', () => {
    // The reveal shows the same number the player bet against, so drift here
    // would read as the game moving the answer after the fact.
    for (const currency of ['EUR', 'GBP'] as const) {
      for (let usd = 500; usd <= 5_000_000; usd += 3_137) {
        const shown = service.fromUsdCents(usd, currency);
        expect(
          Math.abs(service.toUsdCents(shown, currency) - usd),
        ).toBeLessThan(2);
      }
    }
  });

  it('never returns a fractional minor unit', () => {
    for (let usd = 1; usd < 2_000; usd += 7) {
      expect(Number.isInteger(service.fromUsdCents(usd, 'EUR'))).toBe(true);
      expect(Number.isInteger(service.toUsdCents(usd, 'GBP'))).toBe(true);
    }
  });

  it('lists every supported currency with its symbol and vintage', () => {
    expect(service.list()).toEqual([
      { code: 'USD', symbol: '$', rate: 1, asOf: '2026-08-03T00:00:00.000Z' },
      {
        code: 'EUR',
        symbol: '€',
        rate: 0.92,
        asOf: '2026-08-03T00:00:00.000Z',
      },
      {
        code: 'GBP',
        symbol: '£',
        rate: 0.79,
        asOf: '2026-08-03T00:00:00.000Z',
      },
    ]);
  });
});
