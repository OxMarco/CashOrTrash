import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, In, Not } from 'typeorm';

import {
  GameSession,
  SessionStatus,
} from '../sessions/entities/game-session.entity';
import { SessionRound } from '../sessions/entities/session-round.entity';
import { BetPlacedEvent } from '../sessions/events/session.events';
import { Match, MatchStatus } from './entities/match.entity';
import { MatchesGateway } from './matches.gateway';

export interface MatchReconciliation {
  matchId: string;
  roundIndex: number;
  roundResolved: boolean;
  hostScore: number;
  guestScore: number;
  completedNow: boolean;
  winnerUserId: number | null;
}

/**
 * Recomputes authoritative match state from stored rounds. The session service
 * calls this with its transaction manager, so the bet and the match score
 * commit atomically. Socket pushes happen separately after that commit.
 */
@Injectable()
export class MatchesReconciliationService {
  private readonly logger = new Logger(MatchesReconciliationService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly gateway: MatchesGateway,
  ) {}

  reconcileRound(
    matchId: string,
    roundIndex: number,
    manager?: EntityManager,
  ): Promise<MatchReconciliation | null> {
    const run = (entityManager: EntityManager) =>
      this.reconcileWithManager(entityManager, matchId, roundIndex);
    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  /** Best-effort delivery only; clients can always recover via GET /matches/:id. */
  publishAfterCommit(
    event: BetPlacedEvent,
    result: MatchReconciliation | null,
  ): void {
    if (!event.matchId) return;

    try {
      this.gateway.emitOpponentPlaced(event.matchId, {
        userId: event.userId,
        roundIndex: event.roundIndex,
        points: event.points,
        hit: event.hit,
      });

      if (result?.roundResolved) {
        this.gateway.emitRoundAdvanced(result.matchId, {
          roundIndex: result.roundIndex,
          hostScore: result.hostScore,
          guestScore: result.guestScore,
        });
      }

      if (result?.completedNow) {
        this.gateway.emitMatchComplete(result.matchId, {
          hostScore: result.hostScore,
          guestScore: result.guestScore,
          winnerUserId: result.winnerUserId,
        });
      }
    } catch (error) {
      // Socket delivery is ephemeral. The committed match row remains correct,
      // and reconnecting clients load it through the HTTP read model.
      this.logger.warn({ err: error, event }, 'Failed to publish match update');
    }
  }

  private async reconcileWithManager(
    manager: EntityManager,
    matchId: string,
    roundIndex: number,
  ): Promise<MatchReconciliation | null> {
    const match = await manager.getRepository(Match).findOne({
      where: { id: matchId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!match || match.guestUserId === null) return null;

    const sessions = await manager.getRepository(GameSession).find({
      where: { matchId, status: Not(SessionStatus.ABANDONED) },
    });
    const hostSession = sessions.find((s) => s.userId === match.hostUserId);
    const guestSession = sessions.find((s) => s.userId === match.guestUserId);
    if (!hostSession || !guestSession) return null;

    // A transaction manager owns one PostgreSQL client, so issue one query
    // rather than concurrent queries on that client (unsupported in pg 9).
    const playedRounds = await manager.getRepository(SessionRound).find({
      where: { sessionId: In([hostSession.id, guestSession.id]) },
    });
    const hostRounds = playedRounds.filter(
      (round) => round.sessionId === hostSession.id,
    );
    const guestRounds = playedRounds.filter(
      (round) => round.sessionId === guestSession.id,
    );
    const hostByIndex = new Map(hostRounds.map((r) => [r.roundIndex, r]));
    const guestByIndex = new Map(guestRounds.map((r) => [r.roundIndex, r]));

    const roundResolved =
      hostByIndex.has(roundIndex) && guestByIndex.has(roundIndex);
    let hostScore = 0;
    let guestScore = 0;
    for (let index = 0; index < match.itemIds.length; index++) {
      const host = hostByIndex.get(index);
      const guest = guestByIndex.get(index);
      if (!host || !guest) continue;
      if (host.points > guest.points) hostScore++;
      else if (guest.points > host.points) guestScore++;
    }

    const bothFinished =
      hostSession.status === SessionStatus.COMPLETE &&
      guestSession.status === SessionStatus.COMPLETE;
    const completedNow = bothFinished && match.status !== MatchStatus.COMPLETE;
    const changed =
      match.hostScore !== hostScore ||
      match.guestScore !== guestScore ||
      completedNow;

    if (changed) {
      match.hostScore = hostScore;
      match.guestScore = guestScore;
      if (completedNow) {
        match.status = MatchStatus.COMPLETE;
        match.completedAt = new Date();
        match.winnerUserId =
          hostScore === guestScore
            ? null
            : hostScore > guestScore
              ? match.hostUserId
              : match.guestUserId;
      }
      await manager.getRepository(Match).save(match);
    }

    return {
      matchId,
      roundIndex,
      roundResolved,
      hostScore,
      guestScore,
      completedNow,
      winnerUserId: match.winnerUserId,
    };
  }
}
