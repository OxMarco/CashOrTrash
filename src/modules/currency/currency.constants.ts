/**
 * The currencies a player may play in.
 *
 * The catalogue is priced in US dollars and nothing else — an item carries one
 * `truePriceCents` and one pair of slider bounds, all USD. Everything here is a
 * presentation layer over that single stored price, applied at the edge of the
 * API and undone again before a bet is scored. Adding a currency is therefore a
 * line in this file and a rate, not a repricing of the catalogue.
 */
export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP'] as const;

export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/** What a client that says nothing is served — and the unit everything is stored in. */
export const DEFAULT_CURRENCY: Currency = 'USD';

export const CURRENCY_SYMBOLS: Record<Currency, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
};

// All three divide into 100 minor units, which is why a single `*Cents` field
// can carry any of them. A currency without that shape (JPY, KWD) needs an
// exponent per currency before it can be added here.
export const MINOR_UNITS_PER_MAJOR = 100;

export function isCurrency(value: unknown): value is Currency {
  return (
    typeof value === 'string' &&
    (SUPPORTED_CURRENCIES as readonly string[]).includes(value)
  );
}
