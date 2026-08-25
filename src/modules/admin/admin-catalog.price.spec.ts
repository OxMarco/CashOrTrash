import {
  MAX_IMPORT_PRICE_CENTS,
  MIN_IMPORT_PRICE_CENTS,
} from '../catalog/slider';
import { rejectPrice } from './admin-catalog.service';

describe('what an item may be priced at', () => {
  it('accepts the floor itself', () => {
    expect(MIN_IMPORT_PRICE_CENTS).toBe(100);
    expect(rejectPrice(MIN_IMPORT_PRICE_CENTS)).toBeNull();
  });

  it('refuses a cent below it', () => {
    expect(rejectPrice(MIN_IMPORT_PRICE_CENTS - 1)).toMatch(/cheapest/);
  });

  it.each([0, -1, -100_000])('refuses %p, which is not a price', (cents) => {
    expect(rejectPrice(cents)).not.toBeNull();
  });

  it.each([1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2])(
    'refuses %p, which is not a whole number of cents',
    (cents) => {
      expect(rejectPrice(cents)).toMatch(/whole number/);
    },
  );

  /**
   * The other half of the rule. The ceiling is not about an expensive object
   * being harder to price — the slider samples its span in log space precisely
   * so it is not — it is the point where `deriveSlider`'s int32 clamp lands the
   * top bound on or below the answer and the round stops being winnable at all.
   *
   * The eight-figure boat the catalogue already holds sits well under it, which
   * is the property that matters: the bound exists to exclude the unplayable,
   * not to have an opinion about the expensive.
   */
  it('accepts the dearest item the slider can still frame', () => {
    expect(MAX_IMPORT_PRICE_CENTS).toBe(2_000_000_000);
    expect(rejectPrice(1_000_000_00)).toBeNull();
    expect(rejectPrice(16_950_000_00)).toBeNull();
    expect(rejectPrice(MAX_IMPORT_PRICE_CENTS - 1)).toBeNull();
  });

  it('refuses the ceiling itself, where the clamp lands on the answer', () => {
    expect(rejectPrice(MAX_IMPORT_PRICE_CENTS)).toMatch(/dearest/);
  });

  /**
   * Above the ceiling the price also stops fitting the `int` column it is
   * stored in, so this was a 500 on insert even before it was an unplayable
   * round.
   */
  it('refuses a price no column could hold', () => {
    expect(rejectPrice(Number.MAX_SAFE_INTEGER)).toMatch(/dearest/);
  });
});
