import { DEFAULT_THEME_ICON, THEME_ICONS, ThemeIconName } from '../theme-icons';

/** The file inside a category directory that names its glyph. */
export const ICON_FILE = 'icon.txt';

export interface CategoryFolder {
  /** The directory name, as it appears under `items/`. */
  directory: string;
  slug: string;
  name: string;
  iconName: ThemeIconName;
  sortOrder: number;
}

/**
 * The mystery mix, which is a mode rather than a directory.
 *
 * It owns no items — `SessionsService` passes a null themeId and the draw comes
 * from the whole catalogue — so no folder could describe it and it is created
 * whether or not anything else imported. Losing it silently removes a way to
 * play, which is why it is here rather than left to an operator remembering to
 * make an empty directory.
 *
 * `bonusPct` is what makes it worth choosing: at 0 the card promises nothing
 * and `SessionsService` scores it like any other category.
 */
export const MYSTERY_MIX = {
  slug: 'mystery-mix',
  name: 'Mystery mix',
  iconName: 'shuffle' as ThemeIconName,
  sortOrder: 99,
  isMystery: true,
  bonusPct: 0.1,
};

/** `trading cards` -> `trading-cards`. The slug is permanent once created. */
export function slugify(directory: string): string {
  return directory
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * `trading cards` -> `Trading cards`. Sentence case, not title case: these are
 * category labels on a card, and "Trading Cards" reads like a headline.
 */
export function displayName(directory: string): string {
  const cleaned = directory.trim().replace(/[_-]+/g, ' ');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export interface IconResolution {
  iconName: ThemeIconName;
  /** Set when the folder did not name a usable glyph. */
  warning?: string;
}

/**
 * Which glyph a category's card draws.
 *
 * The set is closed and small, and not for our convenience: Metro does not
 * tree-shake, so the app imports each Lucide glyph by name at build time and
 * ships only those. A name it has never heard of renders as the fallback,
 * silently — so an unknown one has to be loud here, at deploy time, where
 * somebody is still looking.
 *
 * A warning rather than a failure. A mistyped glyph is a cosmetic problem, and
 * refusing the deploy over one would hold the whole catalogue hostage to a
 * one-word text file.
 *
 * Adding a glyph is a two-sided change and the app side ships first: add the
 * import and map row in the app's `Icon.tsx`, release it, *then* add the name
 * to `THEME_ICONS`. The other order points live cards at a glyph the installed
 * builds do not have.
 */
export function resolveIcon(
  directory: string,
  contents: string | null,
): IconResolution {
  if (contents === null) {
    return {
      iconName: DEFAULT_THEME_ICON,
      warning: `${directory}/${ICON_FILE} is missing — falling back to "${DEFAULT_THEME_ICON}"`,
    };
  }

  // First non-empty line, so the file can carry a comment underneath.
  const named =
    contents
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('#')) ?? '';

  if (!named) {
    return {
      iconName: DEFAULT_THEME_ICON,
      warning: `${directory}/${ICON_FILE} is empty — falling back to "${DEFAULT_THEME_ICON}"`,
    };
  }

  const match = THEME_ICONS.find((icon) => icon === named.toLowerCase());

  if (!match) {
    return {
      iconName: DEFAULT_THEME_ICON,
      warning:
        `${directory}/${ICON_FILE} names "${named}", which the app does not ship — ` +
        `falling back to "${DEFAULT_THEME_ICON}". Known glyphs: ${THEME_ICONS.join(', ')}`,
    };
  }

  return { iconName: match };
}
