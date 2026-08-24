import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  HealthCheckError,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { Repository } from 'typeorm';

import { AppConfig } from 'src/config/configuration';
import { Item } from 'src/modules/catalog/entities/item.entity';
import { Theme } from 'src/modules/catalog/entities/theme.entity';

const MIN_PLAYABLE_THEMES = 5;

/**
 * A healthy database can still serve an empty game.
 *
 * Readiness includes the minimum content contract so a deployment against an
 * unpopulated catalogue does not go green and then hand its first player a
 * category picker with nothing behind it. The catalogue is filled through the
 * admin portal, so this is the check that says whether that has been done yet
 * — there is no import step left whose failure would otherwise be silent.
 */
@Injectable()
export class CatalogHealthIndicator extends HealthIndicator {
  private readonly roundSize: number;

  constructor(
    @InjectRepository(Item) private readonly items: Repository<Item>,
    @InjectRepository(Theme) private readonly themes: Repository<Theme>,
    config: ConfigService,
  ) {
    super();
    this.roundSize = config.getOrThrow<AppConfig>('app').roundsPerSession;
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    // A database that cannot be reached has to come back as this indicator
    // failing, not as an exception. Terminus only recognises HealthCheckError:
    // a raw driver error escapes the check and turns the whole probe into a 500
    // with no per-dependency body, which is the one thing readiness exists to
    // provide. The other three indicators already guard for the same reason.
    let items: Pick<Item, 'id' | 'themeId'>[];
    let themes: Pick<Theme, 'id'>[];
    try {
      [items, themes] = await Promise.all([
        this.items.find({
          where: { active: true },
          select: { id: true, themeId: true },
        }),
        this.themes.find({
          where: { active: true, isMystery: false },
          select: { id: true },
        }),
      ]);
    } catch (error) {
      throw new HealthCheckError(
        'Catalogue is unreadable',
        this.getStatus(key, false, {
          message: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }

    const activeThemeIds = new Set(themes.map((theme) => theme.id));
    const counts = new Map<number, number>();
    for (const item of items) {
      if (!activeThemeIds.has(item.themeId)) continue;
      counts.set(item.themeId, (counts.get(item.themeId) ?? 0) + 1);
    }

    const playableThemes = [...counts.values()].filter(
      (count) => count >= this.roundSize,
    ).length;
    const details = { importedItems: items.length, playableThemes };

    if (playableThemes < MIN_PLAYABLE_THEMES) {
      throw new HealthCheckError(
        'Catalogue is not ready',
        this.getStatus(key, false, details),
      );
    }

    return this.getStatus(key, true, details);
  }
}
