import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cache } from 'cache-manager';

import { CurrencyConfig } from 'src/config/configuration';
import { Currency, SUPPORTED_CURRENCIES } from './currency.constants';

const RATES_CACHE_KEY = 'currency:rates';

/** The widest a real reference rate ever gets. Outside this the payload is wrong, not the market. */
const MIN_PLAUSIBLE_RATE = 0.01;
const MAX_PLAUSIBLE_RATE = 1_000;

export type RateSnapshot = {
  /** Units of each currency to one US dollar. USD is always exactly 1. */
  rates: Record<Currency, number>;
  /** When the provider published them, ISO 8601. */
  asOf: string;
  /** False while the fallback is standing in for a fetch that has not landed. */
  live: boolean;
};

/**
 * Live exchange rates, base USD.
 *
 * Three properties matter more than the fetching itself.
 *
 * It never blocks a request. The snapshot is served from memory and refreshed
 * on a timer, so a slow or dead provider costs freshness rather than a hung
 * round. Boot does not wait on it either — the process comes up on the last
 * cached snapshot, or on the configured fallback if there is none.
 *
 * It never serves a partial answer. A payload missing a currency, or carrying
 * an implausible number, is rejected whole and the previous snapshot stands.
 * Half-updated rates would price two items in the same round differently.
 *
 * It moves as little as it can get away with. Reference rates are published
 * once a day, and every refresh widens the window in which a round is dealt at
 * one rate and bet at another — which is why `SessionsService` validates a bet
 * with a tolerance rather than against an exact reconstruction of the grid.
 */
@Injectable()
export class ExchangeRatesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExchangeRatesService.name);
  private readonly config: CurrencyConfig;
  private snapshot: RateSnapshot;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    config: ConfigService,
  ) {
    this.config = config.getOrThrow<CurrencyConfig>('currency');
    this.snapshot = {
      rates: {
        USD: 1,
        EUR: this.config.fallbackRates.EUR,
        GBP: this.config.fallbackRates.GBP,
      },
      asOf: new Date(0).toISOString(),
      live: false,
    };
  }

  async onModuleInit(): Promise<void> {
    // Redis first: a replica that restarts mid-day should carry on with the
    // rates its siblings are already using, not drop back to the fallback and
    // reprice every round it serves until its own fetch lands.
    const cached = await this.cache
      .get<RateSnapshot>(RATES_CACHE_KEY)
      .catch(() => null);
    if (cached && this.isPlausible(cached.rates)) this.snapshot = cached;

    void this.refresh();
    this.timer = setInterval(
      () => void this.refresh(),
      this.config.refreshSeconds * 1_000,
    );
    // Every replica refreshes on its own clock. One request an hour each is
    // cheaper than the coordination that would avoid it, and the cache means a
    // failed fetch on one replica is covered by a successful one on another.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The rates in force right now. Synchronous by design — no request waits on the provider. */
  current(): RateSnapshot {
    return this.snapshot;
  }

  /** Fetches, validates, and publishes a new snapshot. Never throws. */
  async refresh(): Promise<RateSnapshot> {
    try {
      const fetched = await this.fetchRates();
      this.snapshot = fetched;
      // TTL well past the refresh cycle: a stale-but-real snapshot is a better
      // cold start than the fallback, and freshness is the timer's job.
      await this.cache
        .set(RATES_CACHE_KEY, fetched, this.config.refreshSeconds * 10 * 1_000)
        .catch(() => undefined);
    } catch (error) {
      // Warn rather than throw: the previous snapshot is still serviceable and
      // the next tick will try again. Silence here would let the game run on
      // month-old rates with nothing in the logs to say so.
      this.logger.warn(
        `Exchange rates could not be refreshed, keeping the ${
          this.snapshot.live ? 'last live' : 'fallback'
        } snapshot: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.snapshot;
  }

  private async fetchRates(): Promise<RateSnapshot> {
    const symbols = SUPPORTED_CURRENCIES.filter((code) => code !== 'USD');
    const url = `${this.config.apiUrl}?base=USD&symbols=${symbols.join(',')}`;

    // `AbortSignal.timeout` rather than the repo's `withTimeout` helper, for
    // the reason PhotoHttpClient gives: `withTimeout` rejects the promise and
    // leaves the socket open, leaking a file descriptor per timed-out fetch.
    // On an hourly timer against an unreachable provider that accumulates.
    // The helper is still right for the health probes, which wrap ioredis and
    // BullMQ calls that take no signal.
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`provider answered ${response.status}`);
    }

    const body: unknown = await response.json();
    const payload = body as { rates?: unknown; date?: unknown } | null;
    const rates = this.readRates(payload?.rates);

    return {
      rates,
      asOf:
        typeof payload?.date === 'string'
          ? new Date(`${payload.date}T00:00:00.000Z`).toISOString()
          : new Date().toISOString(),
      live: true,
    };
  }

  private readRates(value: unknown): Record<Currency, number> {
    const source = (value ?? {}) as Record<string, unknown>;
    const rates: Record<string, number> = { USD: 1 };

    for (const code of SUPPORTED_CURRENCIES) {
      if (code === 'USD') continue;
      const rate = source[code];
      if (typeof rate !== 'number' || !Number.isFinite(rate)) {
        throw new Error(`no usable rate for ${code}`);
      }
      rates[code] = rate;
    }

    const complete = rates as Record<Currency, number>;
    if (!this.isPlausible(complete)) {
      throw new Error('rates outside the plausible range');
    }
    return complete;
  }

  private isPlausible(rates: Record<Currency, number> | undefined): boolean {
    if (!rates) return false;
    return SUPPORTED_CURRENCIES.every((code) => {
      const rate = rates[code];
      return (
        typeof rate === 'number' &&
        Number.isFinite(rate) &&
        rate >= MIN_PLAUSIBLE_RATE &&
        rate <= MAX_PLAUSIBLE_RATE
      );
    });
  }
}
