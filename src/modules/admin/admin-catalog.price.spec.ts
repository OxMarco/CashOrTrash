import { MIN_IMPORT_PRICE_CENTS } from '../catalog/slider';
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
   * The other half of the rule, and the easier one to lose by accident: there
   * is no ceiling. The catalogue already holds an eight-figure boat, and the
   * slider samples its span in log space so an expensive item is no harder to
   * frame than a cheap one.
   */
  it('puts no ceiling on how expensive an item may be', () => {
    expect(rejectPrice(1_000_000_00)).toBeNull();
    expect(rejectPrice(16_950_000_00)).toBeNull();
    expect(rejectPrice(Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});
