import { Injectable } from '@nestjs/common';

import {
  Currency,
  CURRENCY_SYMBOLS,
  SUPPORTED_CURRENCIES,
} from './currency.constants';
import { ExchangeRatesService } from './exchange-rates.service';

/**
 * The one place a US dollar becomes anything else.
 *
 * The catalogue stores a single price per item, in USD, and scoring only ever
 * sees USD. A player who chose euros is served euro-denominated slider bounds
 * derived here, bets in euros, and has that bet converted back here before a
 * single scoring rule looks at it — so the currency is a skin over the stored
 * price rather than a second source of truth that could disagree with it.
 *
 * Rounding is to the nearest minor unit in both directions, which means the
 * round trip is not perfectly lossless: a bet converted to USD and back can
 * land a minor unit from where it started. That is fine for a display value,
 * and it is why `toUsdCents` is only ever applied to a value the caller has
 * already bounds-checked and is about to clamp.
 */
@Injectable()
export class CurrencyService {
  constructor(private readonly exchange: ExchangeRatesService) {}

  /** Units of `currency` to one US dollar, at the rate in force now. */
  rateFor(currency: Currency): number {
    return this.exchange.current().rates[currency];
  }

  /** USD cents into the minor units of `currency`. */
  fromUsdCents(usdCents: number, currency: Currency, rate?: number): number {
    if (currency === 'USD') return usdCents;
    return Math.round(usdCents * (rate ?? this.rateFor(currency)));
  }

  /** Minor units of `currency` back into USD cents. */
  toUsdCents(minorUnits: number, currency: Currency, rate?: number): number {
    if (currency === 'USD') return minorUnits;
    return Math.round(minorUnits / (rate ?? this.rateFor(currency)));
  }

  /** What `GET /currencies` answers: the set a client may pick from, and at what rate. */
  list(): { code: Currency; symbol: string; rate: number; asOf: string }[] {
    const { rates, asOf } = this.exchange.current();
    return SUPPORTED_CURRENCIES.map((code) => ({
      code,
      symbol: CURRENCY_SYMBOLS[code],
      rate: rates[code],
      asOf,
    }));
  }
}
