import { THEME_ICONS } from '../theme-icons';
import { displayName, resolveIcon, slugify } from './category-folder';

describe('slugify', () => {
  it.each([
    ['watches', 'watches'],
    ['trading cards', 'trading-cards'],
    ['LEGO', 'lego'],
    ['  spaced  out  ', 'spaced-out'],
  ])('%s -> %s', (directory, slug) => {
    expect(slugify(directory)).toBe(slug);
  });
});

describe('displayName', () => {
  it('capitalises the first word only — these are labels, not headlines', () => {
    expect(displayName('trading cards')).toBe('Trading cards');
  });
});

describe('resolveIcon', () => {
  it('accepts a glyph the app ships', () => {
    expect(resolveIcon('watches', 'gem')).toEqual({ iconName: 'gem' });
  });

  it('ignores surrounding whitespace and case', () => {
    expect(resolveIcon('watches', '  GEM \n').iconName).toBe('gem');
  });

  it('reads past a leading comment', () => {
    expect(
      resolveIcon('watches', '# the app ships seven\ngem\n').iconName,
    ).toBe('gem');
  });

  /**
   * The app compiles each Lucide glyph in by name, so a name it has never heard
   * of renders as the fallback with nothing to show anyone that it happened.
   * Warning here is what turns that into something visible at deploy time —
   * and a warning rather than a failure, because a mistyped glyph should not
   * hold the whole catalogue hostage.
   */
  it('warns and falls back on a glyph the app does not ship', () => {
    const resolved = resolveIcon('cars', 'car');

    expect(resolved.iconName).toBe('basket');
    expect(resolved.warning).toContain('"car"');
    expect(resolved.warning).toContain('does not ship');
  });

  it.each([
    ['a missing file', null, 'is missing'],
    ['an empty file', '   \n\n', 'is empty'],
    ['comments alone', '# nothing here\n', 'is empty'],
  ])('warns and falls back on %s', (_label, contents, expected) => {
    const resolved = resolveIcon('cars', contents);

    expect(resolved.iconName).toBe('basket');
    expect(resolved.warning).toContain(expected);
  });

  it('accepts every glyph the closed set names', () => {
    for (const icon of THEME_ICONS) {
      expect(resolveIcon('any', icon)).toEqual({ iconName: icon });
    }
  });
});
