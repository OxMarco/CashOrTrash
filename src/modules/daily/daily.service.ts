import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AppConfig } from 'src/config/configuration';
import {
  addDays,
  nextUtcMidnight,
  secondsUntilReset,
  todayUtc,
} from 'src/common/utils/date.util';
import { seedForDate } from 'src/common/utils/seeded-random';
import { CatalogService } from '../catalog/catalog.service';
import { DailyChallenge } from './entities/daily-challenge.entity';

/** Past this share of the catalogue held in reserve, say so at generation. */
const RESERVE_WARN_SHARE = 0.2;

export interface DailyResetInfo {
  challengeDate: string;
  resetsAt: Date;
  secondsUntilReset: number;
}

@Injectable()
export class DailyService {
  private readonly logger = new Logger(DailyService.name);
  private readonly roundsPerSession: number;
  private readonly seedSecret: string;
  private readonly pregenerateDays: number;

  constructor(
    @InjectRepository(DailyChallenge)
    private readonly challenges: Repository<DailyChallenge>,
    private readonly catalog: CatalogService,
    config: ConfigService,
  ) {
    const app = config.getOrThrow<AppConfig>('app');
    this.roundsPerSession = app.roundsPerSession;
    this.seedSecret = app.dailySeedSecret;
    this.pregenerateDays = app.dailyPregenerateDays;
  }

  /**
   * Two players asking for today's challenge must receive the identical
   * ordered set. The generator job normally has it ready a day ahead; this
   * generates on demand as a safety net, and the seed makes both paths agree.
   */
  async getOrCreate(date: string = todayUtc()): Promise<DailyChallenge> {
    const existing = await this.challenges.findOne({
      where: { challengeDate: date },
    });
    if (existing) return existing;

    return this.generate(date);
  }

  /**
   * Idempotent by construction: the draw is a pure function of the date, and
   * a concurrent insert is absorbed by `ON CONFLICT DO NOTHING` followed by a
   * re-read. Two replicas running the job produce the same five items anyway.
   */
  async generate(date: string): Promise<DailyChallenge> {
    const seed = seedForDate(date, this.seedSecret);
    const itemIds = await this.catalog.drawItemIds(
      null,
      this.roundsPerSession,
      seed,
      // `reserveDaily` and nothing else, and the distinction is the whole point:
      // it holds back items already committed to another challenge dated today
      // or later, which is a fact about the calendar rather than about who is
      // asking. "The same five items for everyone" survives it — every player
      // generating this date would be handed the identical exclusion — whereas
      // `excludeSeenBy` would not, which is why it is absent.
      //
      // Without this the days were independent shuffles of one pool, so two of
      // them collided readily: at five items a day over a week's lookahead, a
      // few hundred active items make an overlap near-certain. Sitting Tuesday's
      // challenge then handed the player a price they would be tested on again
      // on Friday — the leak the reserve exists to close, through the one door
      // it was not watching.
      { reserveDaily: true },
    );

    await this.challenges
      .createQueryBuilder()
      .insert()
      .into(DailyChallenge)
      .values({ challengeDate: date, itemIds, seed })
      .orIgnore()
      .execute();

    const challenge = await this.challenges.findOneOrFail({
      where: { challengeDate: date },
    });

    this.logger.log(
      `Daily challenge ready for ${date}: [${challenge.itemIds.join(', ')}]`,
    );
    return challenge;
  }

  /**
   * Called by the scheduled job: today as a backstop, plus the next
   * `DAILY_PREGENERATE_DAYS`.
   *
   * The lookahead is not about job reliability — one spare day covered that.
   * It is the reserve: `CatalogService` holds every item belonging to a
   * challenge dated today or later out of quick and head-to-head draws, so a
   * day that has not been generated yet is a day whose five items are still
   * being handed out with their prices attached. The horizon is how far that
   * protection reaches.
   */
  async ensureUpcoming(now: Date = new Date()): Promise<string[]> {
    const today = todayUtc(now);
    const generated: string[] = [];

    for (let offset = 0; offset <= this.pregenerateDays; offset++) {
      const date = addDays(today, offset);
      const existing = await this.challenges.findOne({
        where: { challengeDate: date },
      });
      if (!existing) {
        await this.generate(date);
        generated.push(date);
      }
    }

    await this.warnIfReserveIsTooDeep();
    return generated;
  }

  /**
   * The reserve is subtracted from the pool every other mode draws from, so a
   * horizon set without reference to the catalogue can starve them: at
   * `roundsPerSession` items a day, a fortnight of lookahead over a small
   * catalogue reserves most of it, and quick rounds fall through to dealing
   * reserved items anyway — which is the ladder working as designed and the
   * protection gone. Loud rather than fatal: the game still plays, and the fix
   * is an operator's (import more items, or shorten the horizon).
   */
  private async warnIfReserveIsTooDeep(): Promise<number> {
    const counts = await this.catalog.itemCountsByTheme();
    const active = [...counts.values()].reduce((sum, n) => sum + n, 0);
    if (active === 0) return 0;

    const reserved = (this.pregenerateDays + 1) * this.roundsPerSession;
    const share = reserved / active;
    if (share > RESERVE_WARN_SHARE) {
      this.logger.warn(
        `Daily reserve is ${Math.round(share * 100)}% of the active catalogue ` +
          `(${reserved} of ${active} items). Quick rounds will start dealing ` +
          `reserved items. Import more items or lower DAILY_PREGENERATE_DAYS.`,
      );
    }
    return reserved;
  }

  /**
   * The Home countdown ("resets in 6h 12m") renders from `resetsAt` rather
   * than the client's own midnight — challenge identity is UTC everywhere, or
   * "same items for everyone" stops being true across timezones.
   */
  resetInfo(now: Date = new Date()): DailyResetInfo {
    return {
      challengeDate: todayUtc(now),
      resetsAt: nextUtcMidnight(now),
      secondsUntilReset: secondsUntilReset(now),
    };
  }
}
