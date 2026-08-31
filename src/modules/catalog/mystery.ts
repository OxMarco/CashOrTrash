/**
 * The mystery mix: five items drawn from the whole catalogue rather than from
 * one category.
 *
 * It is not a `theme` row and never was one. The picker offers it on every
 * build, so making it a row would mean an admin could retire the app's default
 * offer by accident, and a database restored without that hand-inserted row
 * would come up with the mix silently missing from every client. It is a
 * reserved slug instead: the client sends it like any other category, and the
 * draw it names — the whole active catalogue — is the one `drawItemIds`
 * already performs for a null theme, which is how the daily challenge is dealt.
 *
 * Reserved, so `createCategory` refuses it: a category whose name slugified to
 * this would shadow the mix for every player.
 */
export const MYSTERY_THEME_SLUG = 'mystery-mix';

/**
 * The mix's points bonus, 0.1 == +10%.
 *
 * A per-category `bonusPct` lives on the theme row an admin edits. The mix has
 * no row to carry one, so its bonus is a constant — and it earns one because
 * the player gives up knowing what they are about to price. The client shows
 * this same number on the mystery card; the two are only kept in step by this
 * comment, so change both.
 */
export const MYSTERY_BONUS_PCT = 0.1;

/** Whether a requested category slug is the mystery mix rather than a row. */
export function isMysterySlug(slug: string | null | undefined): boolean {
  return slug === MYSTERY_THEME_SLUG;
}
