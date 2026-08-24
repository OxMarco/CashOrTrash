import { slugify } from './admin-catalog.service';

describe('category slugs', () => {
  it.each([
    ['Watches', 'watches'],
    ['Trading Cards', 'trading-cards'],
    ['  Wine  ', 'wine'],
    ['Cars & Bikes', 'cars-bikes'],
    ['Apple///Devices', 'apple-devices'],
  ])('turns %j into %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  // Folded rather than dropped, so a name typed with and without accents does
  // not become two categories the picker shows side by side.
  it('folds diacritics instead of discarding the letters', () => {
    expect(slugify('Gioiellí')).toBe('gioielli');
    expect(slugify('Relógios')).toBe('relogios');
    expect(slugify('Zubehör')).toBe('zubehor');
  });

  it('never ends on a separator, even after truncation', () => {
    const long = slugify(`${'a'.repeat(63)} tail`);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith('-')).toBe(false);
  });

  // The controller turns this into a 400 rather than storing an empty slug.
  it('gives back nothing for a name with no letters or digits', () => {
    expect(slugify('!!! ---')).toBe('');
  });
});
