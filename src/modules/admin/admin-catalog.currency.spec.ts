import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';

import { CatalogService } from '../catalog/catalog.service';
import { Item } from '../catalog/entities/item.entity';
import { Theme } from '../catalog/entities/theme.entity';
import { CurrencyService } from '../currency/currency.service';
import { ExchangeRatesService } from '../currency/exchange-rates.service';
import { ImageProcessor } from '../media/image-processor.service';
import { MediaStore } from '../media/media-store';
import { AdminCatalogService } from './admin-catalog.service';

/**
 * The catalogue is priced in dollars and only in dollars — `truePriceCents`,
 * the slider bounds derived from it, and every scoring rule downstream. What
 * the portal collects is whatever the listing was written in, so the conversion
 * on the way in is the single point where a euro price becomes a stored one.
 *
 * Rates are the real service's shape but fixed here, because what is under test
 * is that the conversion happens at all and in the right direction — not what
 * the euro was worth on the day the suite ran.
 */
const RATES = { USD: 1, EUR: 0.8, GBP: 0.5 };

const currencyService = new CurrencyService({
  current: () => ({
    rates: RATES,
    asOf: '2026-01-01T00:00:00.000Z',
    live: true,
  }),
} as unknown as ExchangeRatesService);

function serviceWith(saved: { value?: Partial<Item> }) {
  const items = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation((value: Partial<Item>) => value),
    save: jest.fn().mockImplementation((value: Partial<Item>) => {
      saved.value = value;
      return Promise.resolve({ id: 1, ...value });
    }),
    exists: jest.fn().mockResolvedValue(false),
  } as unknown as Repository<Item>;

  return new AdminCatalogService(
    items,
    {
      findOne: jest.fn().mockResolvedValue({ id: 1, name: 'Watches' }),
    } as unknown as Repository<Theme>,
    {
      normalise: jest.fn().mockResolvedValue({
        digest: 'a'.repeat(64),
        bytes: Buffer.from('processed'),
      }),
    } as unknown as ImageProcessor,
    { put: jest.fn().mockResolvedValue(undefined) } as unknown as MediaStore,
    {
      invalidateThemes: jest.fn().mockResolvedValue(undefined),
    } as unknown as CatalogService,
    currencyService,
    { add: jest.fn().mockResolvedValue(undefined) } as unknown as Queue,
    {
      getOrThrow: () => ({ root: '/tmp/media', publicBase: '' }),
    } as unknown as ConfigService,
  );
}

const upload = (priceMinorUnits: number, currency: 'USD' | 'EUR' | 'GBP') => ({
  themeId: 1,
  title: 'Watch',
  priceMinorUnits,
  currency,
});

describe('pricing an item the operator entered in another currency', () => {
  it('stores dollars when dollars were typed', async () => {
    const saved: { value?: Partial<Item> } = {};
    await serviceWith(saved).createItem(
      upload(10_000, 'USD'),
      Buffer.from('x'),
    );

    expect(saved.value?.truePriceCents).toBe(10_000);
  });

  /**
   * The rate is units of the currency to one dollar, so converting *into*
   * dollars divides. €80 at 0.8 EUR/USD is $100 — the direction that matters,
   * because inverting it would price every European listing at a fraction of
   * what it is worth and the item would still look perfectly plausible.
   */
  it('divides by the rate rather than multiplying by it', async () => {
    const saved: { value?: Partial<Item> } = {};
    await serviceWith(saved).createItem(upload(8_000, 'EUR'), Buffer.from('x'));

    expect(saved.value?.truePriceCents).toBe(10_000);
  });

  it('converts pounds on their own rate, not the euro one', async () => {
    const saved: { value?: Partial<Item> } = {};
    await serviceWith(saved).createItem(upload(5_000, 'GBP'), Buffer.from('x'));

    expect(saved.value?.truePriceCents).toBe(10_000);
  });

  /**
   * The floor is a dollar, and it is checked *after* conversion. 80 euro cents
   * is 100 US cents and therefore admissible — refusing it on the typed figure
   * would reject a price the catalogue can hold perfectly well.
   */
  it('judges the price it will store, not the one that was typed', async () => {
    const saved: { value?: Partial<Item> } = {};
    await serviceWith(saved).createItem(upload(80, 'EUR'), Buffer.from('x'));

    expect(saved.value?.truePriceCents).toBe(100);
  });

  /** Nothing is asked for it any more; the copy queue fills it. */
  it('leaves the description to the copywriter', async () => {
    const saved: { value?: Partial<Item> } = {};
    await serviceWith(saved).createItem(
      upload(10_000, 'USD'),
      Buffer.from('x'),
    );

    expect(saved.value?.conditionLine).toBe('');
    expect(saved.value?.copyPending).toBe(true);
  });

  it('refuses a converted price below the floor', async () => {
    await expect(
      serviceWith({}).createItem(upload(50, 'EUR'), Buffer.from('x')),
    ).rejects.toThrow(/cheapest/);
  });
});
