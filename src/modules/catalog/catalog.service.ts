import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Cache } from 'cache-manager';
import { In, Repository } from 'typeorm';

import { digestOf } from 'src/common/serialization/digest-of';
import { toDto } from 'src/common/serialization/to-dto';
import { todayUtc } from 'src/common/utils/date.util';
import { SeededRandom } from 'src/common/utils/seeded-random';
import { AppConfig } from 'src/config/configuration';
import { DrawOptions, PoolRow, selectFromTiers } from './draw';
import { ThemeDto } from './dto/theme.dto';
import { Item } from './entities/item.entity';
import { ItemCopy } from './entities/item-copy.entity';
import { ThemeStat } from './entities/theme-stat.entity';
import { Theme } from './entities/theme.entity';
import { DEFAULT_LANGUAGE, Language } from './language.constants';

const THEMES_CACHE_KEY = 'catalog:themes';
const THEMES_CACHE_TTL_MS = 60_000;

const MS_PER_DAY = 86_400_000;

/** Below this many scored rounds the average is noise, so we show no label. */
const MIN_SAMPLE_FOR_LABEL = 25;

/**
 * An item's prose in the language a request asked for.
 *
 * Resolved through this rather than read off the item directly, so that the
 * fallback is one place instead of one per field per endpoint. An item with no
 * copy in the language asked for answers in English, which is the whole reason
 * the translations are a sidecar: a missing row is a `??`, not a 404 and not a
 * blank line under a photograph.
 */
export interface LocalisedCopy {
  title(item: Item): string;
  conditionLine(item: Item): string;
}

const ENGLISH_COPY: LocalisedCopy = {
  title: (item) => item.title,
  conditionLine: (item) => item.conditionLine,
};

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    @InjectRepository(Theme) private readonly themes: Repository<Theme>,
    @InjectRepository(Item) private readonly items: Repository<Item>,
    @InjectRepository(ItemCopy) private readonly copies: Repository<ItemCopy>,
    @InjectRepository(ThemeStat) private readonly stats: Repository<ThemeStat>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly config: ConfigService,
  ) {}

  /** How many items a theme needs before it can deal a round at all. */
  private get roundSize(): number {
    return this.config.getOrThrow<AppConfig>('app').roundsPerSession;
  }

  /** The theme picker's grid plus the Mystery mix row. */
  async listThemes(): Promise<ThemeDto[]> {
    const cached = await this.cache.get<ThemeDto[]>(THEMES_CACHE_KEY);
    if (cached) return cached.map((theme) => toDto(ThemeDto, theme));

    const themes = await this.themes.find({
      where: { active: true },
      // Mystery last — it is the full-width row under the grid. Within the
      // grid the admin's ordering wins, with id as a stable tiebreak so two
      // themes at the same sortOrder do not swap places between requests.
      order: { isMystery: 'ASC', sortOrder: 'ASC', id: 'ASC' },
    });

    const [stats, counts] = await Promise.all([
      this.stats.find({ where: { themeId: In(themes.map((t) => t.id)) } }),
      this.itemCountsByTheme(),
    ]);
    const statByTheme = new Map(stats.map((s) => [s.themeId, s]));

    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

    const dtos = themes
      .map((theme) => ({
        theme,
        // Mystery draws from the whole catalog, so its count is the catalog.
        itemCount: theme.isMystery ? total : (counts.get(theme.id) ?? 0),
      }))
      // An admin creates a category before its items exist. Offering it in the
      // picker would hand the player a card that 404s the moment they tap
      // Start, so a theme joins the grid when it can actually deal a round.
      //
      // Counted without the draw's exclusions on purpose. This list is cached
      // under one global key and digested into the client manifest by
      // `themesVersion`, so a per-player count would poison a shared cache and
      // make the manifest per-player. It stays correct because the exclusions
      // are a preference order, not a filter: the tiers in `selectFromTiers`
      // union to exactly this set, so a theme that passes here can always be
      // dealt, however much the player has already seen.
      .filter(({ itemCount }) => itemCount >= this.roundSize)
      .map(({ theme, itemCount }) =>
        toDto(ThemeDto, {
          ...theme,
          difficultyLabel: this.difficultyLabel(statByTheme.get(theme.id)),
          itemCount,
        }),
      );

    await this.cache.set(THEMES_CACHE_KEY, dtos, THEMES_CACHE_TTL_MS);
    return dtos;
  }

  /**
   * Drops the picker's cached copy. Called at the end of an import — a minute
   * of a stale grid is survivable on its own, but the version below is derived
   * from this payload, and a client polling the manifest would otherwise be
   * told the catalogue is unchanged for as long as the stale copy lived.
   */
  async invalidateThemes(): Promise<void> {
    await this.cache.del(THEMES_CACHE_KEY);
  }

  /**
   * A short digest of exactly what `listThemes` would return.
   *
   * Derived from the payload rather than tracked alongside it, which is the
   * only version scheme that cannot drift: there is no write path to remember
   * to bump, and no way to change what a client sees without changing this.
   * Adding an item to a category that was already visible does not move it —
   * correctly, because the picker is identical.
   *
   * Cheap because it rides on the same cached list the picker is served from,
   * so a client polling this is not costing a query per poll.
   */
  async themesVersion(): Promise<string> {
    return digestOf(await this.listThemes());
  }

  /** "Avg ±22%" — the difficulty tag on an unselected theme card. */
  difficultyLabel(stat?: ThemeStat): string | null {
    if (!stat || stat.sampleSize < MIN_SAMPLE_FOR_LABEL) return null;
    return `Avg ±${Math.round(stat.avgErrorPct * 100)}%`;
  }

  async getThemeBySlug(slug: string): Promise<Theme> {
    const theme = await this.themes.findOne({ where: { slug, active: true } });
    if (!theme) throw new NotFoundException(`Unknown theme: ${slug}`);
    return theme;
  }

  async getThemeById(id: number): Promise<Theme> {
    const theme = await this.themes.findOne({ where: { id } });
    if (!theme) throw new NotFoundException('Unknown theme');
    return theme;
  }

  findItemsByIds(ids: number[]): Promise<Item[]> {
    return this.items.find({ where: { id: In(ids) } });
  }

  /** Ordered exactly as `ids`, which is the order the session plays them in. */
  async findItemsInOrder(ids: number[]): Promise<Item[]> {
    const items = await this.findItemsByIds(ids);
    const byId = new Map(items.map((item) => [item.id, item]));
    return ids
      .map((id) => byId.get(id))
      .filter((item): item is Item => item !== undefined);
  }

  /**
   * The prose for these items in `language`, with English standing in wherever
   * a translation has not been written.
   *
   * One query for the whole round rather than one per item: five items is five
   * round trips otherwise, on the endpoint that is on the critical path of
   * every round dealt.
   */
  async localise(
    language: Language,
    itemIds: number[],
  ): Promise<LocalisedCopy> {
    // English is stored on the item itself and never in `item_copy`, so asking
    // for it is a query that can only come back empty.
    if (language === DEFAULT_LANGUAGE || itemIds.length === 0) {
      return ENGLISH_COPY;
    }

    const rows = await this.copies.find({
      where: { itemId: In(itemIds), locale: language },
    });
    if (rows.length === 0) return ENGLISH_COPY;

    const byId = new Map(rows.map((row) => [row.itemId, row]));
    return {
      title: (item) => byId.get(item.id)?.title ?? item.title,
      conditionLine: (item) =>
        byId.get(item.id)?.conditionLine ?? item.conditionLine,
    };
  }

  /**
   * Draws `count` distinct items. `seed` makes the draw reproducible — the
   * daily generator relies on it; quick rounds pass a random seed.
   *
   * `options` says which items to hold back and is the whole of the anti-cheat
   * story here — see `draw.ts`. The daily generator passes `reserveDaily` but
   * never `excludeSeenBy`: holding back what another challenge already claimed
   * is a fact about the calendar and identical for every player, while a pool
   * filtered by who is asking is not "the same five items for everyone".
   */
  async drawItemIds(
    themeId: number | null,
    count: number,
    seed: string,
    options: DrawOptions = {},
  ): Promise<number[]> {
    const pool = await this.eligibleItems(themeId, options);

    const selection = selectFromTiers(pool, count, new SeededRandom(seed));
    if (!selection) {
      throw new NotFoundException(
        `Not enough active items to build a round (need ${count}, have ${pool.length})`,
      );
    }

    if (selection.dippedIntoReserve) {
      // The draw still returns — refusing to deal a round, or to generate a
      // day, would be worse — but this is the reserve failing to cover the pool
      // it is subtracted from, and it is silent from the player's side. For a
      // round it means an unplayed daily answer was handed out; for the daily
      // generator it means this date reuses an item another date already
      // claimed. Both have the same cause and the same fix.
      this.logger.warn(
        `Draw fell through to items reserved for an upcoming daily ` +
          `(theme ${themeId ?? 'mystery'}, need ${count}, pool ${pool.length}). ` +
          `Import more items or lower DAILY_PREGENERATE_DAYS.`,
      );
    }

    return selection.ids;
  }

  /**
   * The active pool for a draw, each row tagged with why it might be held back.
   *
   * Tagged rather than filtered: the tiers in `selectFromTiers` need to know
   * what was excluded and how recently, so they can fall back through it in a
   * sensible order instead of failing. Both exclusions are computed in SQL —
   * a player's history can run to thousands of items, and shipping those ids
   * into JS to diff them there would grow with how much someone has played.
   *
   * A null themeId means the mystery mix: the whole active catalog.
   */
  private async eligibleItems(
    themeId: number | null,
    options: DrawOptions,
  ): Promise<PoolRow[]> {
    const cooldownDays =
      this.config.getOrThrow<AppConfig>('app').itemCooldownDays;
    // A zero cooldown is "items may repeat immediately", which is the same
    // query as having no player to exclude for.
    const seenBy = cooldownDays > 0 ? (options.excludeSeenBy ?? null) : null;
    const since = new Date(Date.now() - cooldownDays * MS_PER_DAY);

    const rows = await this.items.query(
      `
      WITH reserved AS (
        SELECT DISTINCT x AS id
        FROM daily_challenge d, unnest(d."itemIds") AS x
        WHERE $3::boolean AND d."challengeDate" >= $4::date
      ),
      seen AS (
        -- Only the prefix of the session the player actually reached, not the
        -- five items it was dealt. Rounds behind "currentIndex" have been bet
        -- on and revealed; the round *at* it has been shown only once it was
        -- served. Everything after is an item this player has never laid eyes
        -- on, and counting it spent a month of cooldown on nothing — which
        -- mattered because starting a quick round abandons the previous one,
        -- so backing out of the category picker used to burn five items a tap.
        SELECT x AS id, MAX(s."createdAt") AS "lastSeenAt"
        FROM game_session s,
             unnest(
               s."itemIds"[1 : s."currentIndex" +
                 CASE WHEN s."currentServedAt" IS NOT NULL THEN 1 ELSE 0 END]
             ) AS x
        WHERE $2::int IS NOT NULL
          AND s."userId" = $2::int
          AND s."createdAt" >= $5::timestamptz
        GROUP BY x
      )
      SELECT i.id            AS id,
             (r.id IS NOT NULL) AS reserved,
             v."lastSeenAt"  AS "lastSeenAt"
      FROM item i
      LEFT JOIN reserved r ON r.id = i.id
      LEFT JOIN seen     v ON v.id = i.id
      WHERE i.active = true
        AND ($1::int IS NULL OR i."themeId" = $1::int)
      -- Stable ordering keeps the seeded shuffle reproducible across replicas.
      ORDER BY i.id ASC
      `,
      [
        themeId,
        seenBy,
        options.reserveDaily === true,
        // Not CURRENT_DATE: that is the database session's timezone, and
        // challenge identity is UTC everywhere or "today" means two things.
        todayUtc(),
        since.toISOString(),
      ],
    );

    return (
      rows as Array<{
        id: number;
        reserved: boolean;
        lastSeenAt: Date | null;
      }>
    ).map((row) => ({
      id: Number(row.id),
      reserved: row.reserved,
      lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt) : null,
    }));
  }

  async itemCountsByTheme(): Promise<Map<number, number>> {
    const rows = await this.items
      .createQueryBuilder('i')
      .select('i.themeId', 'themeId')
      .addSelect('COUNT(*)', 'count')
      .where('i.active = true')
      .groupBy('i.themeId')
      .getRawMany<{ themeId: number; count: string }>();

    return new Map(
      rows.map((row) => [Number(row.themeId), Number.parseInt(row.count, 10)]),
    );
  }

  /**
   * Recomputed hourly. Uses the absolute centre error across scored rounds,
   * which is what the "Avg ±22%" label means to a player.
   */
  async recomputeThemeStats(): Promise<number> {
    const rows = await this.items.query(`
      SELECT i."themeId"        AS "themeId",
             AVG(ABS(r."errorPct")) AS "avgErrorPct",
             COUNT(*)           AS "sampleSize"
      FROM session_round r
      JOIN item i ON i.id = r."itemId"
      GROUP BY i."themeId"
    `);

    for (const row of rows as Array<{
      themeId: number;
      avgErrorPct: string;
      sampleSize: string;
    }>) {
      await this.stats
        .createQueryBuilder()
        .insert()
        .into(ThemeStat)
        .values({
          themeId: Number(row.themeId),
          avgErrorPct: Number.parseFloat(row.avgErrorPct) || 0,
          sampleSize: Number.parseInt(row.sampleSize, 10),
        })
        .orUpdate(['avgErrorPct', 'sampleSize', 'updatedAt'], ['themeId'])
        .execute();
    }

    await this.invalidateThemes();
    return (rows as unknown[]).length;
  }
}
