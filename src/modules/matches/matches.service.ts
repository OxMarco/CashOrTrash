import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomInt, randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';

import {
  isPgError,
  PG_UNIQUE_VIOLATION,
} from 'src/common/database/pg-error-codes';
import { toDto } from 'src/common/serialization/to-dto';
import { AppConfig } from 'src/config/configuration';
import { CatalogService } from '../catalog/catalog.service';
import { GameSession } from '../sessions/entities/game-session.entity';
import { SessionRound } from '../sessions/entities/session-round.entity';
import { User } from '../users/entities/user.entity';
import { MatchDto, MatchPlayerDto } from './dto/match.dto';
import { Match, MatchStatus } from './entities/match.entity';
import { MatchesGateway } from './matches.gateway';
import { MatchesReadService } from './matches-read.service';

/** No 0/O/1/I/L — the code gets read aloud and typed by hand. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const CODE_ATTEMPTS = 5;

@Injectable()
export class MatchesService {
  private readonly logger = new Logger(MatchesService.name);
  private readonly app: AppConfig;

  constructor(
    @InjectRepository(Match) private readonly matches: Repository<Match>,
    @InjectRepository(GameSession)
    private readonly sessions: Repository<GameSession>,
    @InjectRepository(SessionRound)
    private readonly rounds: Repository<SessionRound>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly catalog: CatalogService,
    private readonly read: MatchesReadService,
    private readonly gateway: MatchesGateway,
    config: ConfigService,
  ) {
    this.app = config.getOrThrow<AppConfig>('app');
  }

  async create(hostUserId: number, themeSlug: string): Promise<MatchDto> {
    const theme = await this.catalog.getThemeBySlug(themeSlug);
    const itemIds = await this.catalog.drawItemIds(
      theme.isMystery ? null : theme.id,
      this.app.roundsPerSession,
      `match:${randomUUID()}`,
    );

    // Retry on collision rather than pre-checking: the unique index decides.
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      try {
        const match = await this.matches.save(
          this.matches.create({
            id: randomUUID(),
            itemIds,
            themeId: theme.id,
            inviteCode: generateCode(),
            hostUserId,
          }),
        );
        return this.toDtoFor(match);
      } catch (error) {
        if (!isPgError(error, PG_UNIQUE_VIOLATION)) throw error;
        this.logger.warn('Invite code collision; retrying');
      }
    }

    throw new ConflictException('Could not allocate an invite code');
  }

  async join(inviteCode: string, guestUserId: number): Promise<MatchDto> {
    const code = inviteCode.toUpperCase();
    const match = await this.matches.findOne({ where: { inviteCode: code } });
    if (!match) throw new BadRequestException('Unknown invite code');

    if (match.hostUserId === guestUserId) {
      throw new BadRequestException('You cannot join your own match');
    }
    if (match.guestUserId !== null) {
      // Idempotent for the player already in it; a hard stop for anyone else.
      if (match.guestUserId === guestUserId) return this.toDtoFor(match);
      throw new ConflictException('This match is already full');
    }

    // Conditional update: the first joiner wins without a lock.
    const result = await this.matches
      .createQueryBuilder()
      .update(Match)
      .set({ guestUserId, status: MatchStatus.ACTIVE })
      .where('id = :id AND "guestUserId" IS NULL', { id: match.id })
      .execute();

    if (result.affected === 0) {
      throw new ConflictException('This match is already full');
    }

    const joined = await this.read.getById(match.id);
    this.gateway.emitOpponentJoined(joined, guestUserId);
    return this.toDtoFor(joined);
  }

  async getForPlayer(matchId: string, userId: number): Promise<MatchDto> {
    return this.toDtoFor(await this.read.getForPlayer(matchId, userId));
  }

  async toDtoFor(match: Match): Promise<MatchDto> {
    const theme = await this.catalog.getThemeById(match.themeId);
    const [host, guest] = await Promise.all([
      this.playerDto(match, match.hostUserId, match.hostScore),
      match.guestUserId
        ? this.playerDto(match, match.guestUserId, match.guestScore)
        : Promise.resolve(null),
    ]);

    return toDto(MatchDto, {
      id: match.id,
      inviteCode: match.inviteCode,
      deepLink: `${this.app.deepLinkBase}/${match.inviteCode}`,
      status: match.status,
      themeSlug: theme.slug,
      roundCount: match.itemIds.length,
      host,
      guest,
      winnerUserId: match.winnerUserId,
    });
  }

  private async playerDto(
    match: Match,
    userId: number,
    score: number,
  ): Promise<MatchPlayerDto> {
    const [user, session] = await Promise.all([
      this.users.findOne({ where: { id: userId } }),
      this.sessions.findOne({ where: { matchId: match.id, userId } }),
    ]);

    const roundsPlayed = session
      ? await this.rounds.count({ where: { sessionId: session.id } })
      : 0;

    return toDto(MatchPlayerDto, {
      userId,
      username: user?.username ?? null,
      avatarSeed: user?.avatarSeed ?? null,
      score,
      roundsPlayed,
      // Presence on the match socket *is* the live dot next to "vs Maria".
      online: await this.gateway.isOnline(match.id, userId),
    });
  }
}

const generateCode = (): string =>
  Array.from(
    { length: CODE_LENGTH },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
  ).join('');
