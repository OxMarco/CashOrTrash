import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Cache } from 'cache-manager';
import { In, Repository } from 'typeorm';

import { digestOf } from 'src/common/serialization/digest-of';
import { toDto } from 'src/common/serialization/to-dto';
import { SeededRandom } from 'src/common/utils/seeded-random';
import { AppConfig } from 'src/config/configuration';
import { ThemeDto } from './dto/theme.dto';
import { Item } from './entities/item.entity';
import { ThemeStat } from './entities/theme-stat.entity';
import { Theme } from './entities/theme.entity';

const THEMES_CACHE_KEY = 'catalog:themes';
const THEMES_CACHE_TTL_MS = 60_000;

/** Below this many scored rounds the average is noise, so we show no label. */
const MIN_SAMPLE_FOR_LABEL = 25;

@Injectable()
export class CatalogService {
  constructor(
    @InjectRepository(Theme) private readonly themes: Repository<Theme>,
    @InjectRepository(Item) private readonly items: Repository<Item>,
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
   * Draws `count` distinct items. `seed` makes the draw reproducible — the
   * daily generator relies on it; quick rounds pass a random seed.
   */
  async drawItemIds(
    themeId: number | null,
    count: number,
    seed: string,
  ): Promise<number[]> {
    const pool = await this.eligibleItemIds(themeId);
    if (pool.length < count) {
      throw new NotFoundException(
        `Not enough active items to build a round (need ${count}, have ${pool.length})`,
      );
    }
    return new SeededRandom(seed).pick(pool, count);
  }

  /** A null themeId means the mystery mix: the whole active catalog. */
  private async eligibleItemIds(themeId: number | null): Promise<number[]> {
    const query = this.items
      .createQueryBuilder('i')
      .select('i.id', 'id')
      .where('i.active = true')
      // Stable ordering keeps the seeded shuffle reproducible across replicas.
      .orderBy('i.id', 'ASC');

    if (themeId !== null) query.andWhere('i.themeId = :themeId', { themeId });

    const rows = await query.getRawMany<{ id: number }>();
    return rows.map((row) => Number(row.id));
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
