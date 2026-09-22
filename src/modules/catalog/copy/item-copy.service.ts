import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { ItemCopy as ItemCopyRow } from '../entities/item-copy.entity';
import { Item } from '../entities/item.entity';
import { Theme } from '../entities/theme.entity';
import { CatalogService } from '../catalog.service';
import { DIGEST_PATTERN, MediaStore } from '../../media/media-store';
import { splitCondition } from './filename';
import { COPY_LOCALES, findPriceLeak } from './leak-patterns';
import {
  CopywriterUnavailableError,
  ItemCopywriter,
  MAX_TITLE_LENGTH,
  type CopyRequest,
  type ItemCopy,
} from './item-copywriter.service';

/**
 * How many items one run will bill for.
 *
 * The portal uploads one item at a time, so the queue is normally shallow and
 * this never binds. It binds after an outage, when a backlog has built up and
 * the first successful run would otherwise send the whole of it to the model in
 * one batch. A bounded run that repeats is cheaper to reason about than an
 * unbounded one that might time out halfway and be retried from the start.
 */
const BATCH = 24;

export interface CopyReport {
  written: number;
  translated: number;
  failed: number;
  remaining: number;
}

/**
 * Gives an uploaded item the prose a player reads.
 *
 * This is the half of the old boot importer worth keeping. The importer's job
 * was to reconcile a directory tree against the database; this one has no tree
 * to reconcile, only the items the portal flagged. What it inherits is the part
 * that was never about files: asking the model for English copy, refusing copy
 * that leaks the price, translating what survived, and keeping titles unique
 * inside a category.
 */
@Injectable()
export class ItemCopyService {
  private readonly logger = new Logger(ItemCopyService.name);

  constructor(
    @InjectRepository(Item) private readonly items: Repository<Item>,
    @InjectRepository(ItemCopyRow)
    private readonly copies: Repository<ItemCopyRow>,
    @InjectRepository(Theme) private readonly themes: Repository<Theme>,
    private readonly copywriter: ItemCopywriter,
    private readonly catalog: CatalogService,
    private readonly media: MediaStore,
  ) {}

  /** How many items are still owed copy, without doing any of the work. */
  async pending(): Promise<number> {
    return this.items.countBy({ copyPending: true });
  }

  async run(): Promise<CopyReport> {
    const report: CopyReport = {
      written: 0,
      translated: 0,
      failed: 0,
      remaining: 0,
    };

    if (!this.copywriter.available) {
      report.remaining = await this.pending();
      if (report.remaining > 0) {
        this.logger.warn(
          `${report.remaining} item(s) await copy but no OPENAI_API_KEY is configured — ` +
            'they stay playable with the text entered in the portal.',
        );
      }
      return report;
    }

    const queued = await this.items.find({
      where: { copyPending: true },
      order: { id: 'ASC' },
      take: BATCH,
    });
    if (queued.length === 0) return report;

    const themes = await this.themeNames(queued);

    // Grouped by category because a title only has to be unique inside one, and
    // because `taken` is what stops the model naming two watches identically.
    const byTheme = new Map<number, Item[]>();
    for (const item of queued) {
      const group = byTheme.get(item.themeId);
      if (group) group.push(item);
      else byTheme.set(item.themeId, [item]);
    }

    const translatable: TranslatableItem[] = [];
    let outage: CopywriterUnavailableError | null = null;
    for (const [themeId, group] of byTheme) {
      const category = themes.get(themeId) ?? 'Items';
      const taken = await this.titlesIn(themeId);
      const requests = await Promise.all(
        group.map((item) => this.request(item, category, taken)),
      );

      let written: Map<string, ItemCopy>;
      try {
        written = await this.copywriter.write(requests);
      } catch (error) {
        if (!(error instanceof CopywriterUnavailableError)) throw error;
        // Keep what was already paid for; everything else stays flagged.
        outage = error;
        written = error.partial;
      }

      for (const item of group) {
        const ref = String(item.id);
        // Never asked, or asked while the provider was down: the flag stays
        // set so the retry — or the next boot's catch-up — writes it. Only an
        // item the model actually answered for reaches `apply`.
        if (outage && !outage.settled.has(ref)) continue;
        const copy = written.get(ref) ?? null;
        const applied = await this.apply(item, copy, taken, report);
        if (applied) translatable.push({ ...applied, category });
      }

      // The next category would only wait out the same timeout to fail.
      if (outage) break;
    }

    await this.translate(translatable, report);

    report.remaining = await this.pending();
    if (report.written || report.translated) {
      await this.catalog.invalidateThemes();
    }
    this.log(report);

    // Thrown after the bookkeeping, not instead of it: what was written is
    // committed and the cache invalidated, and only then does the job fail so
    // BullMQ's `attempts` retry it with backoff. Once those are exhausted the
    // items are still flagged, and the boot catch-up in `JobsModule` — or the
    // next upload's job — sweeps them up.
    if (outage) {
      this.logger.error(
        `Item copy interrupted: ${outage.message} — ${report.remaining} item(s) stay queued for a retry`,
      );
      throw outage;
    }
    return report;
  }

  /**
   * The item's id doubles as the model's `ref`.
   *
   * The importer had to invent one because its items did not exist in the
   * database yet. These do — the row is written before the model is ever asked
   * — so a reordered reply lines back up against a real primary key rather than
   * against a hash of the bytes.
   */
  private async request(
    item: Item,
    category: string,
    taken: Set<string>,
  ): Promise<CopyRequest> {
    // `sourceName` before `title`, because after one copy pass `title` is the
    // model's and not the operator's. Reading the model's own output back as
    // the source text is what made a rewrite drift: the second pass over
    // "rome apartment 81m2 piazza bologna" saw only "Piazza Bologna Apartment"
    // and the area was gone for good. Null on rows that predate the column.
    const rawText = item.sourceName ?? item.title;

    // Only ever what the *filename* recorded, and usually nothing: a name
    // carries this when it ends in a model year or a card grade, and not
    // otherwise. Empty reaches the copywriter as an absent field rather than
    // as a blank claim.
    //
    // Emphatically not `item.conditionLine`. Nothing collects a condition at
    // upload any more, so that column holds one thing: what the copywriter
    // last wrote. Passing it back as `knownCondition` — a field the brief
    // calls factual — makes Rewrite circular. It handed the model its own
    // previous sentence as a fact about the object and got that sentence
    // returned, which is precisely what the button exists to escape.
    const split = splitCondition(rawText);
    return {
      ref: String(item.id),
      category,
      rawText,
      knownCondition: split.conditionLine,
      taken: [...taken],
      photo: await this.photograph(item),
    };
  }

  /**
   * The item's picture, as the model will see it — which is the same picture
   * the player will see.
   *
   * That equivalence is the whole licence for sending it. A description drawn
   * from this image tells the player nothing they are not already looking at,
   * so it adds detail without adding an advantage; what stays forbidden is the
   * appraisal of that detail, which comes from the model's knowledge rather
   * than from the pixels and is still caught by `findPriceLeak`.
   *
   * The stored derivative rather than the upload: it is what `photoUrl` serves,
   * it has already been stripped of the EXIF a listing photograph carries, and
   * at 1080x864 it costs a fraction of a camera original to send.
   *
   * Undefined rather than throwing when there is no usable blob. A seed item, a
   * row whose bytes were swept, or a store that is briefly unreadable should
   * cost this item its photograph and not the whole batch its copy.
   */
  private async photograph(item: Item): Promise<string | undefined> {
    const digest = digestFromUrl(item.photoUrl);
    if (!digest) return undefined;

    try {
      const stored = await this.media.open(digest);
      if (!stored) return undefined;

      const chunks: Buffer[] = [];
      for await (const chunk of stored.stream) chunks.push(chunk as Buffer);
      const bytes = Buffer.concat(chunks);
      if (bytes.byteLength === 0) return undefined;

      // Inline rather than a URL: the provider cannot reach a media origin that
      // is private, or localhost, or not yet deployed, and a copy pass that
      // silently loses every photograph to a 403 would be hard to notice.
      return `data:image/webp;base64,${bytes.toString('base64')}`;
    } catch (error) {
      this.logger.warn(
        `No photograph for item ${item.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  /**
   * Commits whatever the model returned, and clears the flag either way.
   *
   * "Either way" means the model answered — accepted copy, or a refusal, a
   * truncation or a leak. An item it was never able to answer for, because the
   * provider was down, never reaches here; see `run`.
   *
   * A refusal is not a reason to keep asking. An item that stayed flagged would
   * be re-sent on every run for as long as the model kept declining it, paying
   * repeatedly for the same no. Re-running it is a deliberate act in the portal
   * — the Rewrite button — and not a default.
   *
   * What a refusal costs is the description: the portal no longer collects one,
   * so the item keeps the empty line it was created with until someone asks for
   * a rewrite. That is the honest state of it. Filling the column with a word
   * the model declined to write would be inventing the thing it refused.
   */
  private async apply(
    item: Item,
    copy: ItemCopy | null,
    taken: Set<string>,
    report: CopyReport,
  ): Promise<Omit<TranslatableItem, 'category'> | null> {
    if (!copy) {
      await this.items.update({ id: item.id }, { copyPending: false });
      report.failed += 1;
      this.logger.warn(`No copy written for item ${item.id} ("${item.title}")`);
      return null;
    }

    const title = await this.freeTitle(copy, item, taken);
    await this.items.update(
      { id: item.id },
      { title, conditionLine: copy.conditionLine, copyPending: false },
    );
    taken.delete(item.title);
    taken.add(title);
    report.written += 1;

    return {
      id: item.id,
      rawText: item.sourceName ?? item.title,
      english: { title, conditionLine: copy.conditionLine },
    };
  }

  private async translate(
    items: TranslatableItem[],
    report: CopyReport,
  ): Promise<void> {
    if (items.length === 0) return;

    for (const locale of COPY_LOCALES) {
      const written = await this.copywriter.translate(
        locale,
        items.map((item) => ({
          ref: String(item.id),
          category: item.category,
          rawText: item.rawText,
          english: item.english,
        })),
      );

      for (const item of items) {
        const copy = written.get(String(item.id));
        if (!copy) continue;
        // Upsert rather than insert: re-running copy on an item that already
        // has translations has to replace prose that no longer exists, not
        // collide with it.
        await this.copies.upsert(
          {
            itemId: item.id,
            locale,
            title: copy.title,
            conditionLine: copy.conditionLine,
            writtenAt: new Date(),
          },
          ['itemId', 'locale'],
        );
        report.translated += 1;
      }

      const short = items.length - written.size;
      if (short > 0) {
        this.logger.warn(
          `${short} item(s) have no ${locale} copy and fall back to English`,
        );
      }
    }
  }

  /**
   * A title no other item in this category holds.
   *
   * The unique index would otherwise reject the update and lose copy that has
   * already been paid for. Falls back to the condition line — a year or a grade
   * is what actually distinguishes two objects the model named the same — and
   * only then to a numeric suffix.
   *
   * The condition line is the one just written, not the row's stored one. A
   * portal upload is created with an empty line, so the stored value produced
   * "Rolex Submariner · " — and on a rewrite it is the *previous* description,
   * which may no longer be true of the object. Skipped when empty, and the
   * combination is run back through the filter: each half passed on its own,
   * but the title is now a string nobody has checked as a whole.
   */
  private async freeTitle(
    copy: ItemCopy,
    item: Item,
    taken: Set<string>,
  ): Promise<string> {
    const wanted = copy.title;
    const held = async (candidate: string) => {
      if (candidate !== item.title && taken.has(candidate)) return true;
      const clash = await this.items.findOne({
        where: { themeId: item.themeId, title: candidate },
        select: { id: true },
      });
      return Boolean(clash) && clash?.id !== item.id;
    };

    if (!(await held(wanted))) return wanted;

    const line = copy.conditionLine.trim();
    if (line) {
      const qualified = `${wanted} · ${line}`;
      if (
        qualified.length <= MAX_TITLE_LENGTH &&
        !findPriceLeak(qualified) &&
        !(await held(qualified))
      ) {
        return qualified;
      }
    }

    for (let n = 2; n < 100; n += 1) {
      const numbered = `${wanted} (${n})`;
      if (numbered.length <= MAX_TITLE_LENGTH && !(await held(numbered))) {
        return numbered;
      }
    }

    // Every candidate is taken, which means the category already holds a
    // hundred items by this name. Keep what the portal was given rather than
    // failing the run and stranding the rest of the batch.
    return item.title;
  }

  private async titlesIn(themeId: number): Promise<Set<string>> {
    const rows = await this.items.find({
      where: { themeId },
      select: { title: true },
    });
    return new Set(rows.map((row) => row.title));
  }

  private async themeNames(items: Item[]): Promise<Map<number, string>> {
    const ids = [...new Set(items.map((item) => item.themeId))];
    const rows = await this.themes.find({
      where: { id: In(ids) },
      select: { id: true, name: true },
    });
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  private log(report: CopyReport): void {
    this.logger.log(
      `Item copy: ${report.written} written, ${report.translated} translated, ` +
        `${report.failed} declined, ${report.remaining} still queued`,
    );
  }
}

interface TranslatableItem {
  id: number;
  category: string;
  rawText: string;
  english: ItemCopy;
}

/**
 * The digest a `photoUrl` points at, or null when it points at something else.
 *
 * `photoUrl` is a stored string and may carry an absolute media origin, so the
 * digest is taken from the last path segment rather than by matching the whole
 * value. Checked against `DIGEST_PATTERN` for the reason `MediaStore` checks
 * it: a digest is the only thing that may reach the filesystem.
 */
function digestFromUrl(photoUrl: string): string | null {
  const name = photoUrl.split('/').at(-1) ?? '';
  if (!name.endsWith('.webp')) return null;

  const digest = name.slice(0, -'.webp'.length);
  return DIGEST_PATTERN.test(digest) ? digest : null;
}
