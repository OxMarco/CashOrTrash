/**
 * The glyphs a theme card can be drawn with.
 *
 * Closed rather than free text because the client cannot fetch an icon: Metro
 * does not tree-shake, so the mobile app imports each Lucide glyph by name at
 * build time (`app/src/components/Icon.tsx`) and ships only those. A name it
 * has never heard of renders as the fallback, silently. Validating here turns
 * an admin's typo into a 400 they can see instead of a wrong card nobody
 * notices.
 *
 * Adding an icon is a two-sided change: add the import and map row in the app's
 * `Icon.tsx` first, then the name here. Releasing it in the other order points
 * live cards at a glyph the installed builds do not have.
 */
export const THEME_ICONS = [
  'basket',
  'camera',
  'gem',
  'house',
  'shuffle',
  'calendar',
  'pencil',
] as const;

export type ThemeIconName = (typeof THEME_ICONS)[number];

export const DEFAULT_THEME_ICON: ThemeIconName = 'basket';
