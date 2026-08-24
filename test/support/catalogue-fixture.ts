import { DataSource } from 'typeorm';

import {
  Item,
  ItemOrigin,
} from '../../src/modules/catalog/entities/item.entity';
import { Theme } from '../../src/modules/catalog/entities/theme.entity';
import { ThemeIconName } from '../../src/modules/catalog/theme-icons';
import { PLACEHOLDER_PHOTO_URL } from '../../src/modules/media/placeholder';

/**
 * The catalogue the e2e suite plays against.
 *
 * This replaced the bootstrap seed under `src/database/seeds`, which shipped a
 * hand-authored 26-item catalogue as application code. A real database is
 * filled by the import job reading `items/`, which the suite switches off
 * (`IMPORT_ON_BOOT=false`) so it cannot race these rows — but the specs still
 * need *some* catalogue to deal a round from, so it lives here, in the tests
 * that are its only consumer.
 *
 * Generated rather than authored: what the specs actually depend on is a set of
 * invariants (enough items per theme, a true price comfortably inside its
 * slider), and a generator makes those hold by construction instead of by
 * someone re-checking twenty literals. The prices are invented and mean nothing.
 *
 * Five of the themes are real categories, which is the floor `CatalogHealthIndicator`
 * enforces: `mystery-mix` is excluded there because it owns no items, so a
 * fixture of four real themes plus mystery leaves `/health/ready` permanently
 * red and `platform.e2e-spec` unable to assert a green probe.
 */

/** The slugs specs name directly. `mystery-mix` must be the mystery row. */
interface FixtureTheme {
  slug: string;
  name: string;
  iconName: ThemeIconName;
  sortOrder: number;
  isMystery: boolean;
  bonusPct: number;
  /** Roughly what this theme's items cost, in cents. */
  basePriceCents: number;
}

/**
 * One more than `ROUNDS_PER_SESSION` (5 in `containers.ts`). The picker hides a
 * theme that cannot fill a round, and several specs assert every theme is
 * listed, so this must stay above that floor.
 */
const ITEMS_PER_THEME = 6;

const THEMES: FixtureTheme[] = [
  {
    slug: 'everyday-stuff',
    name: 'Everyday stuff',
    iconName: 'basket',
    sortOrder: 0,
    isMystery: false,
    bonusPct: 0,
    basePriceCents: 4_000,
  },
  {
    slug: 'vintage-finds',
    name: 'Vintage finds',
    iconName: 'camera',
    sortOrder: 1,
    isMystery: false,
    bonusPct: 0,
    basePriceCents: 25_000,
  },
  {
    slug: 'big-money',
    name: 'Big money',
    iconName: 'gem',
    sortOrder: 2,
    isMystery: false,
    bonusPct: 0,
    basePriceCents: 900_000,
  },
  {
    slug: 'homes',
    name: 'Homes',
    iconName: 'house',
    sortOrder: 3,
    isMystery: false,
    bonusPct: 0,
    basePriceCents: 35_000_000,
  },
  {
    slug: 'gadgets',
    name: 'Gadgets',
    iconName: 'plug-zap',
    sortOrder: 4,
    isMystery: false,
    bonusPct: 0,
    basePriceCents: 120_000,
  },
  {
    // Draws from every theme, so it needs no items of its own.
    slug: 'mystery-mix',
    name: 'Mystery mix',
    iconName: 'shuffle',
    sortOrder: 5,
    isMystery: true,
    bonusPct: 0.1,
    basePriceCents: 0,
  },
];

/**
 * What keeps a true price off the round grid slider bounds land on. Every
 * `basePriceCents` above is a multiple of 1,000, so a price is congruent to
 * `n * SALT_CENTS`, which for the handful of items per theme never lands back
 * on it.
 */
const SALT_CENTS = 37;

/**
 * Only the price is fixed here. The slider is drawn per round by `slider.ts`,
 * which guarantees the shape two specs lean on: the true price is strictly
 * inside the bounds, so `lowestLegalRange` in `players.ts` still has a bottom
 * stop that is a guaranteed miss.
 *
 * The salt is what `integrity/price-leak.e2e-spec.ts` needs. It scans raw
 * responses for any true price appearing as a standalone number, and with
 * prices on a plain ×1…×6 ladder one item's slider bound lands exactly on
 * another item's true price — a leak report that is really an arithmetic
 * coincidence. Off-grid prices cannot collide with a bound, which `niceRound`
 * always puts on a round number, and — incidentally — cannot collide with the
 * `-4000-8000-` in the all-zeroes UUID that spec uses to probe a 404 either.
 */
function itemsFor(theme: FixtureTheme) {
  return Array.from({ length: ITEMS_PER_THEME }, (_, index) => {
    const n = index + 1;
    return {
      title: `${theme.name} ${n}`,
      conditionLine: `Fixture item ${n} · ${theme.slug}`,
      truePriceCents: theme.basePriceCents * n + SALT_CENTS * n,
      photoUrl: PLACEHOLDER_PHOTO_URL,
      sourceUrl: `https://example.invalid/${theme.slug}/${n}`,
    };
  });
}

/**
 * Installs the fixture catalogue. Called once from `globalSetup`, before any
 * app exists — `resetGameplayState` then leaves these tables alone, because
 * reseeding between specs would renumber `item.id` and the daily challenge is a
 * deterministic draw over those ids.
 */
export async function installCatalogue(ds: DataSource): Promise<void> {
  await ds.transaction(async (manager) => {
    const themes = manager.getRepository(Theme);
    const items = manager.getRepository(Item);

    for (const fixture of THEMES) {
      const theme = await themes.save(
        themes.create({
          slug: fixture.slug,
          name: fixture.name,
          iconName: fixture.iconName,
          sortOrder: fixture.sortOrder,
          isMystery: fixture.isMystery,
          bonusPct: fixture.bonusPct,
          active: true,
        }),
      );

      if (fixture.isMystery) continue;

      await items.insert(
        itemsFor(fixture).map((item) => ({
          ...item,
          themeId: theme.id,
          origin: ItemOrigin.SEED,
          active: true,
        })),
      );
    }
  });
}
