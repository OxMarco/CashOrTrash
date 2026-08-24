import { GameMode } from '../entities/game-session.entity';

export const SESSION_COMPLETED = 'session.completed';

/**
 * Match state is persisted inside the bet transaction; this value object carries
 * only the post-commit socket notification, which is safe to lose on disconnect.
 */
export class BetPlacedEvent {
  constructor(
    readonly sessionId: string,
    readonly userId: number,
    readonly mode: GameMode,
    readonly matchId: string | null,
    readonly roundIndex: number,
    readonly points: number,
    readonly hit: boolean,
    readonly totalScore: number,
    readonly isSessionComplete: boolean,
  ) {}
}

export class SessionCompletedEvent {
  constructor(
    readonly sessionId: string,
    readonly userId: number,
    readonly mode: GameMode,
    readonly matchId: string | null,
    readonly dailyDate: string | null,
    readonly totalScore: number,
    readonly leaderboardEligible: boolean,
  ) {}
}
