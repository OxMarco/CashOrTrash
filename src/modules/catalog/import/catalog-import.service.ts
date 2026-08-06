import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { In, Not, Repository } from 'typeorm';

import { ImportConfig, MediaConfig } from 'src/config/configuration';
import {
  ImageProcessor,
  ImageRejectedError,
} from 'src/modules/media/image-processor.service';
import { MediaStore } from 'src/modules/media/media-store';
import { CatalogService } from '../catalog.service';
import { Item, ItemOrigin } from '../entities/item.entity';
import { Theme } from '../entities/theme.entity';
import { MIN_IMPORT_PRICE_CENTS } from '../slider';
import {
  CategoryFolder,
  displayName,
  ICON_FILE,
  MYSTERY_MIX,
  resolveIcon,
  slugify,
} from './category-folder';
import { IMAGE_EXT, parseFilename, ParsedFilename } from './filename';
import {
  CopyRequest,
  ItemCopy,
  ItemCopywriter,
} from './item-copywriter.service';

/** What the job did, for the log line and for the specs. */
export interface ImportReport {
  created: number;
  updated: number;
  skipped: number;
  deactivated: number;
  rejected: string[];
  warnings: string[];
}

interface PendingItem {
  ref: string;
  folder: CategoryFolder;
  file: string;
  sourceName: string;
  sourceHash: string;
  bytes: Buffer;
  parsed: ParsedFilename;
  existing: Item | null;
}

/**
 * Builds the catalogue from `items/`.
 *
 * The tree is the source of truth and this reconciles the database to it: a new
 * file becomes an item, a renamed one is corrected in place, a deleted one is
 * retired. Adding items is meant to be nothing more than committing files and
 * redeploying.
 *
 * **Identity is the image, not the title.** The copywriter rewrites titles, so
 * keying on one would make every deploy look like a catalogue of new items. The
 * sha256 of the source bytes is stable across renames, repricings, rewordings
 * and model changes, which is what makes re-running this cheap: an image already
 * imported costs one hash and one indexed lookup, and never an OpenAI call.
 *
 * **One image at a time, deliberately.** sharp decodes outside the V8 heap where
 * `--max-old-space-size` cannot see it, so the cgroup is what stops a runaway
 * decode — and in production `autoheal` turns that kill into an API restart.
 * Sequential keeps peak memory at a single decode however large the tree grows.
 * See the note on the `mediadata` volume in docker-compose.prod.yaml.
 */
@Injectable()
export class CatalogImportService {
  private readonly logger = new Logger(CatalogImportService.name);
  private readonly config: ImportConfig;
  private readonly publicBase: string | undefined;

  constructor(
    @InjectRepository(Item) private readonly items: Repository<Item>,
    @InjectRepository(Theme) private readonly themes: Repository<Theme>,
    private readonly processor: ImageProcessor,
    private readonly store: MediaStore,
    private readonly copywriter: ItemCopywriter,
    private readonly catalog: CatalogService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<ImportConfig>('import');
    this.publicBase = configService.getOrThrow<MediaConfig>('media').publicBase;
  }

  async run(): Promise<ImportReport> {
    const report: ImportReport = {
      created: 0,
      updated: 0,
      skipped: 0,
      deactivated: 0,
      rejected: [],
      warnings: [],
    };

    const folders = await this.readFolders(report);
    if (folders === null) {
      this.logger.warn(
        `No catalogue at ${this.config.itemsRoot} — nothing to import`,
      );
      return report;
    }

    await this.upsertMystery();

    const seenHashes = new Set<string>();
    // Titles already committed in each theme, so the copywriter can be told what
    // not to repeat rather than finding out at the unique index.
    const takenTitles = new Map<number, Set<string>>();

    for (const folder of folders) {
      const themeId = await this.upsertTheme(folder);
      const pending: PendingItem[] = [];

      for (const file of await this.imagesIn(folder.directory)) {
        const prepared = await this.prepare(folder, file, report);
        if (!prepared) continue;

        seenHashes.add(prepared.sourceHash);

        // Already imported, and the filename has not moved. Nothing to do, and
        // nothing decoded or written — this is the path a redeploy takes for
        // everything that was already here.
        if (
          prepared.existing &&
          prepared.existing.sourceName === prepared.sourceName
        ) {
          // Unless it was retired and the file has come back. Retiring is what
          // deleting a file means, so restoring one has to undo it — otherwise
          // the retirement is a one-way door and the only way back is a title
          // nobody can guess. Cheap: one column, no decode and no copy.
          if (!prepared.existing.active) {
            await this.items.update(
              { id: prepared.existing.id },
              { active: true },
            );
            this.logger.log(
              `Restored ${prepared.sourceName} — its file is back`,
            );
            report.updated += 1;
            continue;
          }
          report.skipped += 1;
          continue;
        }
        pending.push(prepared);
      }

      if (pending.length) {
        await this.writeAll(pending, themeId, takenTitles, report);
      }
    }

    report.deactivated = await this.retireMissing(seenHashes);

    if (report.created || report.updated || report.deactivated) {
      await this.catalog.invalidateThemes();
    }

    this.log(report);
    return report;
  }

  // --- reading the tree ------------------------------------------------------

  /** Null when the tree is absent entirely, which is not an error. */
  private async readFolders(
    report: ImportReport,
  ): Promise<CategoryFolder[] | null> {
    let entries: string[];
    try {
      entries = await readdir(this.config.itemsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    const folders: CategoryFolder[] = [];
    // Alphabetical, and that ordering becomes `sortOrder`. A stable default is
    // what matters; the picker's order is not otherwise anybody's decision.
    for (const directory of entries.sort()) {
      const path = join(this.config.itemsRoot, directory);
      if (!(await stat(path)).isDirectory()) continue;

      const slug = slugify(directory);
      if (!slug) {
        report.warnings.push(`${directory}/ has no usable slug — skipped`);
        continue;
      }
      if (slug === MYSTERY_MIX.slug) {
        report.warnings.push(
          `${directory}/ collides with the built-in mystery mix — skipped`,
        );
        continue;
      }

      const icon = resolveIcon(directory, await this.readIcon(directory));
      if (icon.warning) report.warnings.push(icon.warning);

      folders.push({
        directory,
        slug,
        name: displayName(directory),
        iconName: icon.iconName,
        sortOrder: folders.length,
      });
    }

    return folders;
  }

  private async readIcon(directory: string): Promise<string | null> {
    try {
      return await readFile(
        join(this.config.itemsRoot, directory, ICON_FILE),
        'utf8',
      );
    } catch {
      return null;
    }
  }

  private async imagesIn(directory: string): Promise<string[]> {
    const entries = await readdir(join(this.config.itemsRoot, directory));
    return entries.filter((file) => IMAGE_EXT.test(file)).sort();
  }

  // --- categories ------------------------------------------------------------

  /**
   * Create if the slug is new, and leave an existing row alone apart from its
   * icon.
   *
   * The slug is the app's join key (`GameTheme.id = theme.slug`) and permanent.
   * Name and sort order are left alone because they may have been set
   * deliberately; the icon is followed because `icon.txt` is the only way to
   * express one now, so the file has to win.
   */
  private async upsertTheme(folder: CategoryFolder): Promise<number> {
    const existing = await this.themes.findOne({
      where: { slug: folder.slug },
    });

    if (existing) {
      if (existing.iconName !== folder.iconName) {
        await this.themes.update(
          { id: existing.id },
          { iconName: folder.iconName },
        );
      }
      return existing.id;
    }

    const created = await this.themes.save(
      this.themes.create({
        slug: folder.slug,
        name: folder.name,
        iconName: folder.iconName,
        sortOrder: folder.sortOrder,
        isMystery: false,
        bonusPct: 0,
        active: true,
      }),
    );
    this.logger.log(`Category ${folder.slug} created`);
    return created.id;
  }

  private async upsertMystery(): Promise<void> {
    const existing = await this.themes.findOne({
      where: { slug: MYSTERY_MIX.slug },
    });
    if (existing) return;

    await this.themes.save(
      this.themes.create({ ...MYSTERY_MIX, active: true }),
    );
    this.logger.log(`Category ${MYSTERY_MIX.slug} created`);
  }

  // --- items -----------------------------------------------------------------

  /** Everything that can be decided without decoding the image. */
  private async prepare(
    folder: CategoryFolder,
    file: string,
    report: ImportReport,
  ): Promise<PendingItem | null> {
    const sourceName = `${folder.directory}/${file}`;

    const parsed = parseFilename(file);
    if (!parsed) {
      report.rejected.push(
        `${sourceName}: no "_<price>" suffix to read a price from`,
      );
      return null;
    }

    // A slider needs a $1 floor and enough travel to be worth dragging, and
    // below roughly $20 no draw can produce both. Refused here rather than
    // bent around, so the catalogue never holds an item that deals a broken
    // round every time it comes up.
    if (parsed.priceCents < MIN_IMPORT_PRICE_CENTS) {
      report.rejected.push(
        `${sourceName}: $${(parsed.priceCents / 100).toFixed(2)} is under the ` +
          `$${MIN_IMPORT_PRICE_CENTS / 100} minimum a playable round needs`,
      );
      return null;
    }

    const bytes = await readFile(join(this.config.itemsRoot, sourceName));
    const sourceHash = createHash('sha256').update(bytes).digest('hex');

    return {
      ref: sourceHash.slice(0, 12),
      folder,
      file,
      sourceName,
      sourceHash,
      bytes,
      parsed,
      existing: await this.items.findOne({ where: { sourceHash } }),
    };
  }

  private async writeAll(
    pending: PendingItem[],
    themeId: number,
    takenTitles: Map<number, Set<string>>,
    report: ImportReport,
  ): Promise<void> {
    // Only the items whose prose actually has to change. A file renamed to fix
    // its price keeps the copy it already has, which is what stops a repricing
    // from costing a round trip per item.
    const needCopy = pending.filter((item) => this.needsCopy(item));

    const taken =
      takenTitles.get(themeId) ?? (await this.titlesIn(themeId, takenTitles));

    const copy = await this.copywriter.write(
      needCopy.map((item): CopyRequest => ({
        ref: item.ref,
        category: item.folder.name,
        rawText: item.parsed.rawText,
        knownCondition: item.parsed.fallbackCondition,
        taken: [...taken],
      })),
    );

    for (const item of pending) {
      try {
        await this.write(
          item,
          themeId,
          copy.get(item.ref) ?? null,
          taken,
          report,
        );
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        report.rejected.push(`${item.sourceName}: ${why}`);
      }
    }
  }

  /**
   * Whether the model needs to see this item at all.
   *
   * New files always. An existing item only when the descriptive half of its
   * filename changed — a price correction leaves the object the same object,
   * and rewriting the prose for one would be a bill for nothing.
   */
  private needsCopy(item: PendingItem): boolean {
    if (!item.existing) return true;
    const before = item.existing.sourceName ?? '';
    const previous = parseFilename(before.split('/').pop() ?? '');
    return previous?.rawText !== item.parsed.rawText;
  }

  private async titlesIn(
    themeId: number,
    cache: Map<number, Set<string>>,
  ): Promise<Set<string>> {
    const rows = await this.items.find({
      where: { themeId },
      select: { title: true },
    });
    const titles = new Set(rows.map((row) => row.title));
    cache.set(themeId, titles);
    return titles;
  }

  private async write(
    item: PendingItem,
    themeId: number,
    copy: ItemCopy | null,
    taken: Set<string>,
    report: ImportReport,
  ): Promise<void> {
    const photoUrl = await this.storePhoto(item);

    const fields = {
      title: copy?.title ?? item.parsed.fallbackTitle,
      conditionLine: copy?.conditionLine ?? item.parsed.fallbackCondition,
      themeId,
      truePriceCents: item.parsed.priceCents,
      photoUrl,
      sourceHash: item.sourceHash,
      sourceName: item.sourceName,
      origin: ItemOrigin.IMPORT,
      active: true,
    };

    // Two different objects can be handed the same name — by the model, or by
    // the fallback when two filenames differ only in their price. The index
    // refuses the second, so it is distinguished rather than dropped.
    const title = await this.freeTitle(fields.title, item, themeId, taken);
    if (title !== fields.title) {
      report.warnings.push(
        `${item.sourceName}: "${fields.title}" was taken in ${item.folder.slug} — stored as "${title}"`,
      );
      fields.title = title;
    }

    if (item.existing) {
      await this.items.update({ id: item.existing.id }, fields);
      taken.delete(item.existing.title);
      report.updated += 1;
    } else {
      await this.items.save(this.items.create(fields));
      report.created += 1;
    }

    taken.add(fields.title);
  }

  /**
   * A title no other item in the category holds.
   *
   * Falls back to appending what the filename knew about condition — a year or
   * a grade — which is the detail that actually distinguishes two rows named
   * the same thing, and only then to a numeric suffix.
   */
  private async freeTitle(
    wanted: string,
    item: PendingItem,
    themeId: number,
    taken: Set<string>,
  ): Promise<string> {
    const held = async (candidate: string) => {
      if (candidate !== item.existing?.title && taken.has(candidate)) {
        return true;
      }
      const clash = await this.items.findOne({
        where: { themeId, title: candidate },
        select: { id: true },
      });
      return Boolean(clash) && clash?.id !== item.existing?.id;
    };

    if (!(await held(wanted))) return wanted;

    const qualified = `${wanted} · ${item.parsed.fallbackCondition}`;
    if (qualified.length <= 120 && !(await held(qualified))) return qualified;

    for (let n = 2; n < 100; n += 1) {
      const numbered = `${wanted} (${n})`;
      if (numbered.length <= 120 && !(await held(numbered))) return numbered;
    }

    throw new Error(`could not find a free title for "${wanted}"`);
  }

  private async storePhoto(item: PendingItem): Promise<string> {
    try {
      const washed = await this.processor.wash(item.bytes);
      await this.store.put(washed.digest, washed.bytes);
      await this.store.put(washed.thumbDigest, washed.thumbBytes);
      return `${this.publicBase ?? ''}/media/items/${washed.digest}.webp`;
    } catch (error) {
      if (error instanceof ImageRejectedError) {
        throw new Error(`${error.reason}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Retire anything whose file is gone, so deleting an image stops it being
   * dealt.
   *
   * Deactivated rather than deleted: `session_round` references items with
   * `onDelete: RESTRICT`, so a played item cannot be removed, and a scoreboard
   * that silently lost the round it was built from would be worse than a row
   * nobody draws. Rows predating the import have no `sourceHash` and are left
   * alone — this only governs what it put there.
   */
  private async retireMissing(seen: Set<string>): Promise<number> {
    const stale = await this.items.find({
      where: {
        active: true,
        origin: ItemOrigin.IMPORT,
        ...(seen.size ? { sourceHash: Not(In([...seen])) } : {}),
      },
      select: { id: true, sourceName: true },
    });
    if (stale.length === 0) return 0;

    await this.items.update(
      { id: In(stale.map((row) => row.id)) },
      { active: false },
    );
    for (const row of stale) {
      this.logger.log(`Retired ${row.sourceName} — its file is gone`);
    }
    return stale.length;
  }

  private log(report: ImportReport): void {
    for (const warning of report.warnings) this.logger.warn(warning);

    this.logger.log(
      `Catalogue import: ${report.created} created, ${report.updated} updated, ` +
        `${report.skipped} unchanged, ${report.deactivated} retired`,
    );

    if (report.rejected.length) {
      // Loud, and never silently: a rejected item is a hole in a category, and
      // enough of them in one category drop it below the item count the picker
      // needs to offer it at all.
      this.logger.warn(
        `${report.rejected.length} item(s) could not be imported:`,
      );
      for (const line of report.rejected) this.logger.warn(`  - ${line}`);
    }
  }
}
