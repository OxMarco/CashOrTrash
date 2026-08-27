import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';

import { MediaConfig } from 'src/config/configuration';
import { CatalogService } from 'src/modules/catalog/catalog.service';
import { Item, ItemOrigin } from 'src/modules/catalog/entities/item.entity';
import { Theme } from 'src/modules/catalog/entities/theme.entity';
import {
  MAX_IMPORT_PRICE_CENTS,
  MIN_IMPORT_PRICE_CENTS,
} from 'src/modules/catalog/slider';
import {
  DEFAULT_THEME_ICON,
  THEME_ICONS,
  type ThemeIconName,
} from 'src/modules/catalog/theme-icons';
import {
  ImageProcessor,
  ImageRejectedError,
} from 'src/modules/media/image-processor.service';
import { MediaStore } from 'src/modules/media/media-store';
import { JOBS, MAINTENANCE_QUEUE } from 'src/modules/jobs/jobs.constants';

export interface CategoryInput {
  name: string;
  iconName?: string;
  sortOrder?: number;
}

export interface ItemInput {
  themeId: number;
  title: string;
  conditionLine: string;
  priceCents: number;
  sourceUrl?: string | null;
}

/**
 * What is wrong with a price, or null if nothing is.
 *
 * Neither bound is a taste call, and neither is about how hard the object is to
 * price — the catalogue runs to eight figures and the slider is drawn in log
 * space precisely so it scales. Both are the points at which `deriveSlider`
 * stops being able to frame the answer at all.
 *
 * Below `MIN_IMPORT_PRICE_CENTS` the slider's flat floor outranks its
 * proportional one and the left end lands on or above the answer. At or above
 * `MAX_IMPORT_PRICE_CENTS` the int32 clamp on the top bound lands it on or
 * below the answer. Either way the item deals a round no bet can win, silently,
 * every time it comes up. Zero and negatives fall out of the same comparison as
 * the floor, so there is no separate positivity check.
 *
 * Exported for its own spec, like `slugify` — it is the one rule in here worth
 * pinning without standing a whole service up behind it. The file-tree import
 * used to enforce it; item creation now happens only through `createItem`, so
 * this is the only place left that can.
 */
export function rejectPrice(priceCents: number): string | null {
  if (!Number.isSafeInteger(priceCents)) {
    return 'The price must be a whole number of cents.';
  }
  if (priceCents < MIN_IMPORT_PRICE_CENTS) {
    return `The cheapest item a round can be built around is $${MIN_IMPORT_PRICE_CENTS / 100}.`;
  }
  if (priceCents >= MAX_IMPORT_PRICE_CENTS) {
    return (
      'The dearest item a round can be built around is under $' +
      `${(MAX_IMPORT_PRICE_CENTS / 100).toLocaleString('en-US')}.`
    );
  }
  return null;
}

@Injectable()
export class AdminCatalogService {
  private readonly logger = new Logger(AdminCatalogService.name);
  private readonly publicBase: string;

  constructor(
    @InjectRepository(Item) private readonly items: Repository<Item>,
    @InjectRepository(Theme) private readonly themes: Repository<Theme>,
    private readonly processor: ImageProcessor,
    private readonly store: MediaStore,
    private readonly catalog: CatalogService,
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
    config: ConfigService,
  ) {
    this.publicBase = config.getOrThrow<MediaConfig>('media').publicBase ?? '';
  }

  /**
   * The origin item photographs are served from, or empty when they are
   * same-origin. The portal's Content-Security-Policy needs it to allow the
   * thumbnails in the item list.
   */
  get mediaOrigin(): string {
    if (!this.publicBase) return '';
    try {
      return new URL(this.publicBase).origin;
    } catch {
      return '';
    }
  }

  // --- categories ------------------------------------------------------------

  async listCategories(): Promise<
    Array<Theme & { itemCount: number; pendingCopy: number }>
  > {
    const themes = await this.themes.find({
      order: { sortOrder: 'ASC', id: 'ASC' },
    });
    const counts = await this.catalog.itemCountsByTheme();
    const pending = await this.pendingByTheme();
    return themes.map((theme) => ({
      ...theme,
      itemCount: counts.get(theme.id) ?? 0,
      pendingCopy: pending.get(theme.id) ?? 0,
    }));
  }

  async createCategory(input: CategoryInput): Promise<Theme> {
    const name = input.name.trim();
    if (!name) throw new BadRequestException('A category needs a name.');

    const slug = slugify(name);
    if (!slug) {
      throw new BadRequestException(
        'That name has no letters or digits to build a slug from.',
      );
    }
    if (await this.themes.findOne({ where: { slug }, select: { id: true } })) {
      throw new ConflictException(`A category "${slug}" already exists.`);
    }

    const icon = (input.iconName ?? DEFAULT_THEME_ICON) as ThemeIconName;
    if (!THEME_ICONS.includes(icon)) {
      throw new BadRequestException(`"${icon}" is not a known icon.`);
    }

    const theme = await this.themes.save(
      this.themes.create({
        slug,
        name,
        iconName: icon,
        sortOrder: input.sortOrder ?? 0,
        active: true,
      }),
    );
    await this.catalog.invalidateThemes();
    this.logger.log(`Created category "${name}" (${slug})`);
    return theme;
  }

  async setCategoryActive(id: number, active: boolean): Promise<void> {
    const theme = await this.themes.findOne({ where: { id } });
    if (!theme) throw new NotFoundException('No such category.');
    await this.themes.update({ id }, { active });
    await this.catalog.invalidateThemes();
  }

  // --- items -----------------------------------------------------------------

  async listItems(themeId: number): Promise<Item[]> {
    return this.items.find({
      where: { themeId },
      order: { id: 'DESC' },
    });
  }

  /**
   * Stores the photograph and the typed-in facts, then hands the prose to the
   * queue.
   *
   * Deliberately not awaiting the model. An upload that waited would hold the
   * request open for as long as four language passes take and fail the whole
   * upload — photograph included — if OpenAI were slow or down. The row is
   * complete and playable the moment this returns; `copyPending` is the promise
   * that it will read better shortly.
   */
  async createItem(input: ItemInput, photo: Buffer): Promise<Item> {
    const theme = await this.themes.findOne({ where: { id: input.themeId } });
    if (!theme) throw new NotFoundException('No such category.');

    const title = input.title.trim();
    if (!title) throw new BadRequestException('An item needs a name.');
    const priceProblem = rejectPrice(input.priceCents);
    if (priceProblem) throw new BadRequestException(priceProblem);

    const { digest, photoUrl } = await this.storePhoto(photo);

    // No rollback delete on failure. The store is content-addressed, so two
    // uploads of the same photograph share one path: a cleanup here would run
    // `exists(sourceHash)` against a competing request that has passed its own
    // duplicate check but not yet committed, see no reference, and delete the
    // blob out from under the row that request is about to write. `MediaGcService`
    // is the reclamation path and is built for exactly this — it only collects
    // blobs that are both unreferenced and older than MEDIA_ORPHAN_GRACE_MS, so
    // an in-flight write is never the one it takes. The cost of leaving this to
    // the sweep is one orphaned blob per failed create, for up to a day.
    return this.createStoredItem(input, theme, title, digest, photoUrl);
  }

  private async createStoredItem(
    input: ItemInput,
    theme: Theme,
    title: string,
    digest: string,
    photoUrl: string,
  ): Promise<Item> {
    // The photograph is the item's identity, so the same file twice is the same
    // item — the unique index would refuse it anyway, and a plain conflict says
    // so far better than a constraint violation.
    const existing = await this.items.findOne({
      where: { sourceHash: digest },
      select: { id: true, title: true },
    });
    if (existing) {
      throw new ConflictException(
        `That photograph is already in the catalogue as "${existing.title}".`,
      );
    }

    const item = await this.items.save(
      this.items.create({
        title: await this.freeTitle(title, input.themeId),
        conditionLine: input.conditionLine.trim(),
        truePriceCents: input.priceCents,
        themeId: input.themeId,
        photoUrl,
        sourceHash: digest,
        sourceName: null,
        sourceUrl: input.sourceUrl?.trim() || null,
        origin: ItemOrigin.MANUAL,
        active: true,
        copyPending: true,
      }),
    );

    await this.catalog.invalidateThemes();
    await this.queue.add(JOBS.ITEM_COPY, {});
    this.logger.log(`Added "${item.title}" to ${theme.name} (item ${item.id})`);
    return item;
  }

  async setItemActive(id: number, active: boolean): Promise<void> {
    const item = await this.items.findOne({ where: { id } });
    if (!item) throw new NotFoundException('No such item.');
    await this.items.update({ id }, { active });
    await this.catalog.invalidateThemes();
  }

  /** Puts an item back in the copy queue — for a refusal, or a bad result. */
  async requeueCopy(id: number): Promise<void> {
    const item = await this.items.findOne({ where: { id } });
    if (!item) throw new NotFoundException('No such item.');
    await this.items.update({ id }, { copyPending: true });
    await this.queue.add(JOBS.ITEM_COPY, {});
  }

  // --- internals -------------------------------------------------------------

  private async storePhoto(
    bytes: Buffer,
  ): Promise<{ digest: string; photoUrl: string }> {
    try {
      const stored = await this.processor.normalise(bytes);
      await this.store.put(stored.digest, stored.bytes);
      return {
        digest: stored.digest,
        photoUrl: `${this.publicBase}/media/items/${stored.digest}.webp`,
      };
    } catch (error) {
      if (error instanceof ImageRejectedError) {
        throw new BadRequestException(`${error.reason}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * The copy job has its own version of this, and both are needed.
   *
   * This one guards the insert, which the unique index would otherwise reject
   * with a 500 the operator cannot act on. The job's guards the update it makes
   * after the model has renamed the item to something a sibling already holds.
   */
  private async freeTitle(wanted: string, themeId: number): Promise<string> {
    const held = async (candidate: string) =>
      Boolean(
        await this.items.findOne({
          where: { themeId, title: candidate },
          select: { id: true },
        }),
      );

    if (!(await held(wanted))) return wanted;
    for (let n = 2; n < 100; n += 1) {
      const numbered = `${wanted} (${n})`;
      if (numbered.length <= 120 && !(await held(numbered))) return numbered;
    }
    throw new ConflictException(
      `This category already holds a hundred items named "${wanted}".`,
    );
  }

  private async pendingByTheme(): Promise<Map<number, number>> {
    // Counted in the database rather than by pulling every outstanding row
    // across the wire to length them in JS — the answer is one integer per
    // category either way.
    const rows = await this.items
      .createQueryBuilder('i')
      .select('i.themeId', 'themeId')
      .addSelect('COUNT(*)', 'count')
      .where('i.copyPending = true')
      .groupBy('i.themeId')
      .getRawMany<{ themeId: number; count: string }>();

    return new Map(
      rows.map((row) => [Number(row.themeId), Number.parseInt(row.count, 10)]),
    );
  }
}

/**
 * A URL-safe, stable slug. Diacritics are folded rather than dropped so
 * "Gioielli" and "Gioiellí" do not become two different categories.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}
