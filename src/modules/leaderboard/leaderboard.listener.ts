import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { GameMode } from '../sessions/entities/game-session.entity';
import {
  SESSION_COMPLETED,
  SessionCompletedEvent,
} from '../sessions/events/session.events';
import { LeaderboardService } from './leaderboard.service';

@Injectable()
export class LeaderboardListener {
  private readonly logger = new Logger(LeaderboardListener.name);

  constructor(private readonly leaderboard: LeaderboardService) {}

  /**
   * Only the daily challenge is ranked — everyone plays the same five items,
   * which is the only way scores are comparable. Quick rounds let a player
   * pick an easy theme and would make the board meaningless. The authoritative
   * Postgres row is already in the bet transaction; this idempotent call mirrors
   * it to Redis and is repaired hourly if the process dies before it runs.
   */
  @OnEvent(SESSION_COMPLETED, { async: true })
  async onSessionCompleted(event: SessionCompletedEvent): Promise<void> {
    if (event.mode !== GameMode.DAILY || !event.dailyDate) return;

    try {
      await this.leaderboard.recordDailyScore(
        event.userId,
        event.dailyDate,
        event.totalScore,
      );
    } catch (error) {
      this.logger.error({ err: error, event }, 'Failed to record daily score');
    }
  }
}
