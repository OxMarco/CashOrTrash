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

export interface DailyResetInfo {
  challengeDate: string;
  resetsAt: Date;
  secondsUntilReset: number;
}

@Injectable()
export class DailyService {
  private readonly logger = new Logger(DailyService.name);
  private readonly roundsPerSession: number;

  constructor(
    @InjectRepository(DailyChallenge)
    private readonly challenges: Repository<DailyChallenge>,
    private readonly catalog: CatalogService,
    config: ConfigService,
  ) {
    this.roundsPerSession =
      config.getOrThrow<AppConfig>('app').roundsPerSession;
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
    const seed = seedForDate(date);
    const itemIds = await this.catalog.drawItemIds(
      null,
      this.roundsPerSession,
      seed,
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

  /** Called by the scheduled job: today as a backstop, plus tomorrow. */
  async ensureUpcoming(now: Date = new Date()): Promise<string[]> {
    const today = todayUtc(now);
    const generated: string[] = [];

    for (const date of [today, addDays(today, 1)]) {
      const existing = await this.challenges.findOne({
        where: { challengeDate: date },
      });
      if (!existing) {
        await this.generate(date);
        generated.push(date);
      }
    }

    return generated;
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
