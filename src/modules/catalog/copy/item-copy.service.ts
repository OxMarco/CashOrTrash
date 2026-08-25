import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { ItemCopy as ItemCopyRow } from '../entities/item-copy.entity';
import { Item } from '../entities/item.entity';
import { Theme } from '../entities/theme.entity';
import { CatalogService } from '../catalog.service';
import { splitCondition } from './filename';
import { COPY_LOCALES } from './leak-patterns';
import {
  ItemCopywriter,
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
    for (const [themeId, group] of byTheme) {
      const category = themes.get(themeId) ?? 'Items';
      const taken = await this.titlesIn(themeId);
      const written = await this.copywriter.write(
        group.map((item) => this.request(item, category, taken)),
      );

      for (const item of group) {
        const copy = written.get(String(item.id)) ?? null;
        const applied = await this.apply(item, copy, taken, report);
        if (applied) translatable.push({ ...applied, category });
      }
    }

    await this.translate(translatable, report);

    report.remaining = await this.pending();
    if (report.written || report.translated) {
      await this.catalog.invalidateThemes();
    }
    this.log(report);
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
  private request(
    item: Item,
    category: string,
    taken: Set<string>,
  ): CopyRequest {
    const split = splitCondition(item.title);
    return {
      ref: String(item.id),
      category,
      rawText: item.title,
      knownCondition: item.conditionLine || split.conditionLine,
      taken: [...taken],
    };
  }

  /**
   * Commits whatever the model returned, and clears the flag either way.
   *
   * A refusal is not a reason to keep asking. The item already has the text
   * that was typed into the portal, which is a correct description if a plain
   * one, and an item that stayed flagged would be re-sent on every run for as
   * long as the model kept declining it — paying repeatedly for the same no.
   * Re-running it is a deliberate act in the portal, not a default.
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

    const title = await this.freeTitle(copy.title, item, taken);
    await this.items.update(
      { id: item.id },
      { title, conditionLine: copy.conditionLine, copyPending: false },
    );
    taken.delete(item.title);
    taken.add(title);
    report.written += 1;

    return {
      id: item.id,
      rawText: item.title,
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
   */
  private async freeTitle(
    wanted: string,
    item: Item,
    taken: Set<string>,
  ): Promise<string> {
    const held = async (candidate: string) => {
      if (candidate !== item.title && taken.has(candidate)) return true;
      const clash = await this.items.findOne({
        where: { themeId: item.themeId, title: candidate },
        select: { id: true },
      });
      return Boolean(clash) && clash?.id !== item.id;
    };

    if (!(await held(wanted))) return wanted;

    const qualified = `${wanted} · ${item.conditionLine}`.trim();
    if (qualified.length <= 120 && !(await held(qualified))) return qualified;

    for (let n = 2; n < 100; n += 1) {
      const numbered = `${wanted} (${n})`;
      if (numbered.length <= 120 && !(await held(numbered))) return numbered;
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
