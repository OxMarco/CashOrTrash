import {
  BadRequestException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { ThrottlerException } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In, MoreThan, Repository } from 'typeorm';

import {
  isPgError,
  PG_UNIQUE_VIOLATION,
} from 'src/common/database/pg-error-codes';
import { toDto } from 'src/common/serialization/to-dto';
import { todayUtc } from 'src/common/utils/date.util';
import { AppConfig, BillingConfig } from 'src/config/configuration';
import { isPremium, quickRoundsToday } from '../billing/entitlement';
import { CatalogService } from '../catalog/catalog.service';
import { isMysterySlug, MYSTERY_THEME_SLUG } from '../catalog/mystery';
import { deriveSliderBoundsSet } from '../catalog/slider';
import { DailyService } from '../daily/daily.service';
import { inviteHasExpired } from '../matches/match-expiry';
import { MatchesReadService } from '../matches/matches-read.service';
import { CURRENT_SCORING } from '../scoring/constants';
import { User } from '../users/entities/user.entity';
import { CreateSessionDto, SessionDto } from './dto/session.dto';
import {
  GameMode,
  GameSession,
  SessionStatus,
} from './entities/game-session.entity';

/** Deals or resumes sessions; gameplay and settlement remain in SessionsService. */
@Injectable()
export class SessionCreationService {
  private readonly app: AppConfig;
  private readonly billing: BillingConfig;

  constructor(
    @InjectRepository(GameSession)
    private readonly sessions: Repository<GameSession>,
    private readonly dataSource: DataSource,
    private readonly catalog: CatalogService,
    private readonly daily: DailyService,
    private readonly matches: MatchesReadService,
    config: ConfigService,
  ) {
    this.app = config.getOrThrow<AppConfig>('app');
    this.billing = config.getOrThrow<BillingConfig>('billing');
  }

  async createOrResume(
    userId: number,
    dto: CreateSessionDto,
  ): Promise<SessionDto> {
    switch (dto.mode) {
      case GameMode.DAILY:
        return this.createOrResumeDaily(userId);
      case GameMode.QUICK:
        return this.createQuick(userId, dto.themeSlug);
      case GameMode.H2H:
        return this.createOrResumeH2h(userId, dto.inviteCode);
    }
  }

  private async createOrResumeDaily(userId: number): Promise<SessionDto> {
    const date = todayUtc();
    const existing = await this.sessions.findOne({
      where: { userId, mode: GameMode.DAILY, dailyDate: date },
    });
    if (existing) return this.toSessionDto(existing, true);

    const challenge = await this.daily.getOrCreate(date);
    try {
      const created = await this.sessions.save(
        this.sessions.create({
          id: randomUUID(),
          userId,
          mode: GameMode.DAILY,
          dailyDate: date,
          themeId: null,
          itemIds: challenge.itemIds,
          sliderMinCents: challenge.sliderMinCents,
          sliderMaxCents: challenge.sliderMaxCents,
          scoringVersion: challenge.scoringVersion ?? CURRENT_SCORING.version,
        }),
      );
      return this.toSessionDto(created, false);
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION)) {
        const winner = await this.sessions.findOneOrFail({
          where: { userId, mode: GameMode.DAILY, dailyDate: date },
        });
        return this.toSessionDto(winner, true);
      }
      throw error;
    }
  }

  private async createQuick(
    userId: number,
    themeSlug?: string,
  ): Promise<SessionDto> {
    if (!themeSlug) {
      throw new BadRequestException('themeSlug is required for a quick round');
    }

    const created = await this.dataSource.transaction(async (manager) => {
      const player = await manager.getRepository(User).findOne({
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!player) throw new NotFoundException('Player not found');
      await this.enforceFreeAllowance(player, manager);
      await this.enforceRoundBudget(userId, manager);

      // The mystery mix is a reserved slug, not a row: it deals from the whole
      // active catalogue, which is the null-theme draw the daily challenge
      // already uses. A session dealt that way has no theme to point at, and
      // `themeId` stays null exactly as it does for a daily.
      const theme = isMysterySlug(themeSlug)
        ? null
        : await this.catalog.getThemeBySlug(themeSlug);
      const themeId = theme && !theme.isMystery ? theme.id : null;
      const itemIds = await this.catalog.drawItemIds(
        themeId,
        this.app.roundsPerSession,
        `quick:${userId}:${randomUUID()}`,
        { reserveDaily: true, excludeSeenBy: userId },
      );

      const sessionRepo = manager.getRepository(GameSession);
      await sessionRepo.update(
        { userId, mode: GameMode.QUICK, status: SessionStatus.ACTIVE },
        { status: SessionStatus.ABANDONED },
      );

      const id = randomUUID();
      const items = await this.catalog.findItemsInOrder(itemIds);
      const sliderBounds = deriveSliderBoundsSet(
        { id, mode: GameMode.QUICK, dailyDate: null, matchId: null },
        items,
        this.app.sliderSeedSecret,
      );
      return sessionRepo.save(
        sessionRepo.create({
          id,
          userId,
          mode: GameMode.QUICK,
          themeId,
          itemIds,
          ...sliderBounds,
          scoringVersion: CURRENT_SCORING.version,
        }),
      );
    });

    return this.toSessionDto(created, false);
  }

  /**
   * The freemium line. Counted under the player's row lock, which every quick
   * deal takes first, so two taps racing for the last free round get one.
   *
   * 402 with its own slug, not the 429 below: this is not "slow down", it is
   * "this needs premium", and the app answers it with the paywall.
   */
  private async enforceFreeAllowance(
    player: User,
    manager: EntityManager,
  ): Promise<void> {
    const limit = this.billing.freeQuickRoundsPerDay;
    if (limit <= 0 || isPremium(player)) return;

    if ((await quickRoundsToday(manager, player.id)) >= limit) {
      throw new HttpException(
        {
          message: 'Today’s free rounds are used up',
          error: 'free-rounds-exhausted',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
  }

  private async enforceRoundBudget(
    userId: number,
    manager: EntityManager,
  ): Promise<void> {
    if (this.app.quickSessionsPerHour <= 0) return;

    const recent = await manager.getRepository(GameSession).count({
      where: {
        userId,
        mode: In([GameMode.QUICK, GameMode.H2H]),
        createdAt: MoreThan(new Date(Date.now() - 3_600_000)),
      },
    });
    if (recent >= this.app.quickSessionsPerHour) {
      throw new ThrottlerException('Too many rounds — take a breather');
    }
  }

  private async createOrResumeH2h(
    userId: number,
    inviteCode?: string,
  ): Promise<SessionDto> {
    if (!inviteCode) {
      throw new BadRequestException(
        'inviteCode is required for a head-to-head',
      );
    }

    const match = await this.matches.getByInviteCodeForPlayer(
      inviteCode,
      userId,
    );
    const existing = await this.sessions.findOne({
      where: { userId, matchId: match.id },
    });
    if (existing) return this.toSessionDto(existing, true);

    if (inviteHasExpired(match, this.app.matchInviteTtlDays)) {
      throw new GoneException('This challenge has expired');
    }

    try {
      const created = await this.dataSource.transaction(async (manager) => {
        const player = await manager.getRepository(User).findOne({
          where: { id: userId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!player) throw new NotFoundException('Player not found');
        await this.enforceRoundBudget(userId, manager);

        const sessionRepo = manager.getRepository(GameSession);
        return sessionRepo.save(
          sessionRepo.create({
            id: randomUUID(),
            userId,
            mode: GameMode.H2H,
            themeId: match.themeId,
            matchId: match.id,
            itemIds: match.itemIds,
            sliderMinCents: match.sliderMinCents,
            sliderMaxCents: match.sliderMaxCents,
            scoringVersion: match.scoringVersion ?? CURRENT_SCORING.version,
          }),
        );
      });
      return this.toSessionDto(created, false);
    } catch (error) {
      if (!isPgError(error, PG_UNIQUE_VIOLATION)) throw error;
      const winner = await this.sessions.findOne({
        where: { userId, matchId: match.id },
      });
      if (!winner) throw error;
      return this.toSessionDto(winner, true);
    }
  }

  private async toSessionDto(
    session: GameSession,
    resumed: boolean,
  ): Promise<SessionDto> {
    const theme = session.themeId
      ? await this.catalog.getThemeById(session.themeId)
      : null;
    // A themeless daily is the calendar's round and names no category; a
    // themeless quick or head-to-head is the mystery mix, and the client
    // resolves that slug against the card it is already showing.
    const mystery = !theme && session.mode !== GameMode.DAILY;
    return toDto(SessionDto, {
      id: session.id,
      mode: session.mode,
      status: session.status,
      currentIndex: session.currentIndex,
      roundCount: session.itemIds.length,
      totalScore: session.totalScore,
      themeSlug: theme?.slug ?? (mystery ? MYSTERY_THEME_SLUG : null),
      themeName: theme?.name ?? (mystery ? 'Mystery mix' : null),
      matchId: session.matchId,
      resumed,
    });
  }
}
