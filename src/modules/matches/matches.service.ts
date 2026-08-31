import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
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
import { isMysterySlug, MYSTERY_THEME_SLUG } from '../catalog/mystery';
import { deriveSliderBoundsSet } from '../catalog/slider';
import { CURRENT_SCORING } from '../scoring/constants';
import { GameSession } from '../sessions/entities/game-session.entity';
import { SessionRound } from '../sessions/entities/session-round.entity';
import { User } from '../users/entities/user.entity';
import { MatchDto, MatchPlayerDto } from './dto/match.dto';
import { Match, MatchStatus } from './entities/match.entity';
import { inviteHasExpired } from './match-expiry';
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
    // As in `createQuick`: the mystery mix is a reserved slug rather than a
    // category, and both players face the same whole-catalogue draw.
    const theme = isMysterySlug(themeSlug)
      ? null
      : await this.catalog.getThemeBySlug(themeSlug);
    const themeId = theme && !theme.isMystery ? theme.id : null;
    const itemIds = await this.catalog.drawItemIds(
      themeId,
      this.app.roundsPerSession,
      `match:${randomUUID()}`,
      // Only the host's history is known here — the guest has not joined yet,
      // and both sides must face the same five items, so there is no second
      // set to filter. The daily reservation is the exclusion that matters for
      // the leaderboard, and it protects both players regardless.
      { reserveDaily: true, excludeSeenBy: hostUserId },
    );
    const matchId = randomUUID();
    const items = await this.catalog.findItemsInOrder(itemIds);
    const sliderBounds = deriveSliderBoundsSet(
      { id: matchId, mode: 'h2h', dailyDate: null, matchId },
      items,
      this.app.sliderSeedSecret,
    );

    // Retry on collision rather than pre-checking: the unique index decides.
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      try {
        const match = await this.matches.save(
          this.matches.create({
            id: matchId,
            itemIds,
            ...sliderBounds,
            scoringVersion: CURRENT_SCORING.version,
            themeId,
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
    // Ahead of the "already full" checks, so the reason given is the true one:
    // an invite that expired and one that somebody else took are different
    // things to be told, and only this one is the host's to fix.
    if (inviteHasExpired(match, this.app.matchInviteTtlDays)) {
      throw new GoneException('This challenge has expired');
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

  /**
   * The host withdrawing a code they have not placed yet.
   *
   * Host-only and pending-only. Once a guest is in, the match is no longer one
   * player's to end — the other has usually already played it, and discarding
   * their rounds from the other side is not a cancellation, it is a forfeit
   * with no record.
   *
   * Idempotent: cancelling an already-expired match returns it rather than
   * failing, because the caller's intent is satisfied either way and the app
   * retries this on a flaky connection.
   */
  async cancel(matchId: string, hostUserId: number): Promise<MatchDto> {
    const match = await this.read.getById(matchId);

    if (match.hostUserId !== hostUserId) {
      throw new ForbiddenException('Only the host can withdraw a challenge');
    }
    if (match.status === MatchStatus.EXPIRED) return this.toDtoFor(match);
    if (match.status !== MatchStatus.PENDING) {
      throw new ConflictException('Someone has already joined this challenge');
    }

    // Conditional on still being unclaimed, for the same reason `join` is: a
    // guest arriving between the read above and this write must win, rather
    // than being dropped into a match the host has just withdrawn.
    const result = await this.matches
      .createQueryBuilder()
      .update(Match)
      .set({ status: MatchStatus.EXPIRED })
      .where('id = :id AND "guestUserId" IS NULL AND status = :pending', {
        id: matchId,
        pending: MatchStatus.PENDING,
      })
      .execute();

    if (result.affected === 0) {
      throw new ConflictException('Someone has already joined this challenge');
    }

    return this.toDtoFor(await this.read.getById(matchId));
  }

  /**
   * Flips invites that have aged past the TTL. Returns how many moved.
   *
   * Hygiene, not enforcement — `inviteHasExpired` is what actually keeps a
   * stale code from being redeemed, and it does so the moment the deadline
   * passes rather than at the next sweep. What this buys is an honest `status`
   * for anything that reads the column, and a `pending` set that stays the
   * size of the genuinely open invites.
   */
  async expireStaleInvites(now: Date = new Date()): Promise<number> {
    const ttlDays = this.app.matchInviteTtlDays;
    if (ttlDays <= 0) return 0;

    const cutoff = new Date(now.getTime() - ttlDays * 86_400_000);
    const result = await this.matches
      .createQueryBuilder()
      .update(Match)
      .set({ status: MatchStatus.EXPIRED })
      .where('status = :pending AND "createdAt" < :cutoff', {
        pending: MatchStatus.PENDING,
        cutoff,
      })
      .execute();

    const expired = result.affected ?? 0;
    if (expired > 0) this.logger.log(`Expired ${expired} unanswered invite(s)`);
    return expired;
  }

  async toDtoFor(match: Match): Promise<MatchDto> {
    // Presence for the whole room once, then read per player below. Both
    // players are in the same room, and the lookup is a cluster-wide broadcast.
    const [theme, online] = await Promise.all([
      match.themeId ? this.catalog.getThemeById(match.themeId) : null,
      this.gateway.onlineUserIds(match.id),
    ]);

    const [host, guest] = await Promise.all([
      this.playerDto(match, match.hostUserId, match.hostScore, online),
      match.guestUserId
        ? this.playerDto(match, match.guestUserId, match.guestScore, online)
        : Promise.resolve(null),
    ]);

    return toDto(MatchDto, {
      id: match.id,
      inviteCode: match.inviteCode,
      deepLink: `${this.app.deepLinkBase}/${match.inviteCode}`,
      status: match.status,
      themeSlug: theme?.slug ?? MYSTERY_THEME_SLUG,
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
    online: Set<number>,
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
      online: online.has(userId),
    });
  }
}

const generateCode = (): string =>
  Array.from(
    { length: CODE_LENGTH },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
  ).join('');
