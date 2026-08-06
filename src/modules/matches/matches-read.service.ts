import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { toDto } from 'src/common/serialization/to-dto';
import { OpponentStateDto } from '../sessions/dto/session.dto';
import { GameSession } from '../sessions/entities/game-session.entity';
import { SessionRound } from '../sessions/entities/session-round.entity';
import { User } from '../users/entities/user.entity';
import { Match, MatchStatus } from './entities/match.entity';

/**
 * Read-side of a match, split out so SessionsModule can depend on it without
 * the two modules importing each other. The write side reacts to
 * `BetPlacedEvent` over the event bus, which needs no import at all.
 */
@Injectable()
export class MatchesReadService {
  constructor(
    @InjectRepository(Match) private readonly matches: Repository<Match>,
    @InjectRepository(GameSession)
    private readonly sessions: Repository<GameSession>,
    @InjectRepository(SessionRound)
    private readonly rounds: Repository<SessionRound>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async getById(matchId: string): Promise<Match> {
    const match = await this.matches.findOne({ where: { id: matchId } });
    if (!match) throw new NotFoundException('Match not found');
    return match;
  }

  async getForPlayer(matchId: string, userId: number): Promise<Match> {
    const match = await this.getById(matchId);
    if (match.hostUserId !== userId && match.guestUserId !== userId) {
      throw new ForbiddenException('You are not in this match');
    }
    return match;
  }

  async getByInviteCodeForPlayer(
    inviteCode: string,
    userId: number,
  ): Promise<Match> {
    const match = await this.matches.findOne({
      where: { inviteCode: inviteCode.toUpperCase() },
    });
    if (!match) throw new NotFoundException('Unknown invite code');
    if (match.hostUserId !== userId && match.guestUserId !== userId) {
      throw new ForbiddenException('Join the match before playing it');
    }
    if (match.status === MatchStatus.COMPLETE) {
      throw new ForbiddenException('This match is already over');
    }
    return match;
  }

  opponentIdOf(match: Match, userId: number): number | null {
    return match.hostUserId === userId ? match.guestUserId : match.hostUserId;
  }

  async opponentUsername(
    matchId: string,
    userId: number,
  ): Promise<string | null> {
    const match = await this.getById(matchId);
    const opponentId = this.opponentIdOf(match, userId);
    if (!opponentId) return null;

    const opponent = await this.users.findOne({ where: { id: opponentId } });
    return opponent?.username ?? null;
  }

  /** The "vs Maria · You lead 3–1" block on the gameplay and reveal screens. */
  async opponentState(
    matchId: string,
    userId: number,
    roundIndex: number | null,
  ): Promise<OpponentStateDto> {
    const match = await this.getById(matchId);
    const isHost = match.hostUserId === userId;
    const opponentId = this.opponentIdOf(match, userId);

    const yourScore = isHost ? match.hostScore : match.guestScore;
    const opponentScore = isHost ? match.guestScore : match.hostScore;

    let opponentRoundPoints: number | null = null;
    if (opponentId !== null && roundIndex !== null) {
      const session = await this.sessions.findOne({
        where: { matchId, userId: opponentId },
      });
      if (session) {
        const round = await this.rounds.findOne({
          where: { sessionId: session.id, roundIndex },
        });
        opponentRoundPoints = round?.points ?? null;
      }
    }

    const opponent = opponentId
      ? await this.users.findOne({ where: { id: opponentId } })
      : null;

    return toDto(OpponentStateDto, {
      matchId,
      opponentUsername: opponent?.username ?? null,
      yourScore,
      opponentScore,
      opponentRoundPoints,
      leadLabel: leadLabel(
        yourScore,
        opponentScore,
        opponent?.username ?? null,
      ),
    });
  }
}

/** En dash to match the prototype's "You lead 3–1" banner. */
const leadLabel = (
  yours: number,
  theirs: number,
  opponentName: string | null,
): string | null => {
  if (yours > theirs) return `You lead ${yours}–${theirs}`;
  if (theirs > yours) {
    return `${opponentName ?? 'Opponent'} leads ${theirs}–${yours}`;
  }
  return null;
};
