import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { ThrottlerException } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  MoreThan,
  Repository,
} from 'typeorm';

import {
  isPgError,
  PG_UNIQUE_VIOLATION,
} from 'src/common/database/pg-error-codes';
import { toDto } from 'src/common/serialization/to-dto';
import { todayUtc } from 'src/common/utils/date.util';
import { AppConfig } from 'src/config/configuration';
import { CatalogService } from '../catalog/catalog.service';
import { LocalisedCopy } from '../catalog/catalog.service';
import { Item } from '../catalog/entities/item.entity';
import { ItemCopy } from '../catalog/entities/item-copy.entity';
import { DEFAULT_LANGUAGE, Language } from '../catalog/language.constants';
import { deriveSlider, SliderBounds, sliderSeed } from '../catalog/slider';
import { Currency, DEFAULT_CURRENCY } from '../currency/currency.constants';
import { CurrencyService } from '../currency/currency.service';
import { DailyService } from '../daily/daily.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { inviteHasExpired } from '../matches/match-expiry';
import { MatchesReadService } from '../matches/matches-read.service';
import {
  MatchReconciliation,
  MatchesReconciliationService,
} from '../matches/matches-reconciliation.service';
import { PricingService } from '../scoring/pricing.service';
import { ScoringService } from '../scoring/scoring.service';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  CreateSessionDto,
  CurrentRoundDto,
  PlaceBetDto,
  RevealResponseDto,
  RoundResultDto,
  SessionDto,
  SessionSummaryDto,
} from './dto/session.dto';
import {
  GameMode,
  GameSession,
  SessionStatus,
} from './entities/game-session.entity';
import { SessionRound } from './entities/session-round.entity';
import {
  BetPlacedEvent,
  SESSION_COMPLETED,
  SessionCompletedEvent,
} from './events/session.events';
import { buildShareText } from './share-text';

/** A day, which is far past any reading of "how long did that round take". */
const MAX_ELAPSED_MS = 24 * 60 * 60 * 1000;

/**
 * How many times `getCurrentRound` may restart after a bet beats it to the
 * stamp. Comfortably above the rounds in a session, so an honest race always
 * resolves and only a genuine loop hits it.
 */
const MAX_ROUND_RESTARTS = 8;

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);
  private readonly app: AppConfig;

  constructor(
    @InjectRepository(GameSession)
    private readonly sessions: Repository<GameSession>,
    @InjectRepository(SessionRound)
    private readonly rounds: Repository<SessionRound>,
    private readonly dataSource: DataSource,
    private readonly catalog: CatalogService,
    private readonly daily: DailyService,
    private readonly scoring: ScoringService,
    private readonly pricing: PricingService,
    private readonly currency: CurrencyService,
    private readonly users: UsersService,
    private readonly leaderboard: LeaderboardService,
    private readonly matches: MatchesReadService,
    private readonly matchReconciliation: MatchesReconciliationService,
    private readonly events: EventEmitter2,
    config: ConfigService,
  ) {
    this.app = config.getOrThrow<AppConfig>('app');
  }

  // --- creation -----------------------------------------------------------

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

  /**
   * Idempotent, which is what makes Home's "Continue · round 3" work without a
   * second endpoint: asking for today's daily twice returns the same session.
   */
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
        }),
      );
      return this.toSessionDto(created, false);
    } catch (error) {
      // The partial unique index caught a concurrent double-tap on "Play".
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

    await this.enforceRoundBudget(userId);

    const theme = await this.catalog.getThemeBySlug(themeSlug);
    const itemIds = await this.catalog.drawItemIds(
      theme.isMystery ? null : theme.id,
      this.app.roundsPerSession,
      // Quick rounds are explicitly *not* reproducible — a fresh seed each time.
      `quick:${userId}:${randomUUID()}`,
      // The reveal at the end of every round is an answer, and a quick round is
      // the cheapest way to collect one. Hold back what a daily still needs to
      // ask, and what this player has already been shown.
      { reserveDaily: true, excludeSeenBy: userId },
    );

    // Starting a new quick round retires the previous one rather than leaving
    // orphaned "active" sessions behind.
    await this.sessions.update(
      { userId, mode: GameMode.QUICK, status: SessionStatus.ACTIVE },
      { status: SessionStatus.ABANDONED },
    );

    const created = await this.sessions.save(
      this.sessions.create({
        id: randomUUID(),
        userId,
        mode: GameMode.QUICK,
        themeId: theme.id,
        itemIds,
      }),
    );

    return this.toSessionDto(created, false);
  }

  /**
   * The ceiling on how fast one account can be dealt new items.
   *
   * The throttler above this caps requests; this caps *rounds*, which is the
   * unit that matters — every completed round hands back a true price, so an
   * unmetered round is a catalogue export with a progress bar. It does not make
   * harvesting impossible (the cooldown expires, and patience beats a rate
   * limit); it makes the sweep long enough to notice.
   *
   * Counted across quick *and* head-to-head, because the budget is about
   * reveals and those two modes reveal identically. Gating quick alone left the
   * cheaper door open: `POST /matches` allows 20 a minute and each match backs
   * a five-round session, so a limit written as 30 rounds an hour was really
   * thousands. The daily is exempt — it is one session a day by unique index,
   * which is a tighter budget than this one could express.
   *
   * Deliberately the first thing a *creating* path does, and never on a
   * resuming one: it runs before the theme lookup and before the previous
   * session is retired, so a player who is over budget keeps the round they
   * were in the middle of and can still return to a match already under way.
   */
  private async enforceRoundBudget(userId: number): Promise<void> {
    if (this.app.quickSessionsPerHour <= 0) return;

    const recent = await this.sessions.count({
      where: {
        userId,
        mode: In([GameMode.QUICK, GameMode.H2H]),
        createdAt: MoreThan(new Date(Date.now() - 3_600_000)),
      },
    });

    if (recent >= this.app.quickSessionsPerHour) {
      // A ThrottlerException so this lands as a 429 through the same filter,
      // and the client has one vocabulary for "slow down" rather than two.
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

    // Below the resume above, and deliberately so. An invite that aged out is
    // refused a *new* deal, but a host who is three rounds into one when the
    // deadline passes keeps their game: locking someone out of rounds they
    // have already played is a worse answer to a friend who never showed up
    // than simply letting the match finish unanswered.
    if (inviteHasExpired(match, this.app.matchInviteTtlDays)) {
      throw new GoneException('This challenge has expired');
    }

    // Below the resume above, so rejoining a match in progress is always free
    // and only a *new* five-item deal spends budget.
    await this.enforceRoundBudget(userId);

    try {
      const created = await this.sessions.save(
        this.sessions.create({
          id: randomUUID(),
          userId,
          mode: GameMode.H2H,
          themeId: match.themeId,
          matchId: match.id,
          // Both players get the identical ordered set — "best of 5, same items".
          itemIds: match.itemIds,
        }),
      );
      return this.toSessionDto(created, false);
    } catch (error) {
      if (!isPgError(error, PG_UNIQUE_VIOLATION)) throw error;

      // A concurrent double-tap won the (userId, matchId) unique index.
      const winner = await this.sessions.findOne({
        where: { userId, matchId: match.id },
      });
      if (!winner) throw error;
      return this.toSessionDto(winner, true);
    }
  }

  // --- gameplay -----------------------------------------------------------

  async getCurrentRound(
    sessionId: string,
    userId: number,
    currency: Currency = DEFAULT_CURRENCY,
    language: Language = DEFAULT_LANGUAGE,
    /**
     * How many times this call has already restarted after losing the stamping
     * race below. Bounded because the restart is the one path here that calls
     * itself: a session has only `roundsPerSession` rounds and each restart
     * needs a bet to have landed in the gap between two statements, so reaching
     * the ceiling means something is looping rather than racing — and a 409
     * beats exhausting the stack.
     */
    attempt = 0,
  ): Promise<CurrentRoundDto> {
    const session = await this.getOwnedSession(sessionId, userId);

    if (session.status !== SessionStatus.ACTIVE) {
      throw new ConflictException('This session is already finished');
    }
    if (session.currentIndex >= session.itemIds.length) {
      throw new ConflictException('No rounds left in this session');
    }

    const itemId = session.itemIds[session.currentIndex];
    const [item] = await this.catalog.findItemsByIds([itemId]);
    if (!item) throw new NotFoundException('Item not found');

    // Stamp once for this index. A retry must not restart the player's timer,
    // and a stale GET racing a bet must not stamp the next round early. This is
    // also the whole of the shot clock's integrity: the deadline is set by the
    // server, once, and re-fetching a round returns what is left of it rather
    // than a fresh ten seconds.
    if (session.currentServedAt === null) {
      const servedAt = new Date();
      const stamped = await this.sessions.update(
        {
          id: session.id,
          status: SessionStatus.ACTIVE,
          currentIndex: session.currentIndex,
          currentServedAt: IsNull(),
        },
        { currentServedAt: servedAt },
      );
      if (stamped.affected === 1) {
        session.currentServedAt = servedAt;
      } else {
        // Lost the race to a concurrent GET. Whatever it wrote is the stamp the
        // deadline is measured from, so read it back rather than counting down
        // from a moment nothing was recorded at. Guarded on the index, because
        // the request that beat us may have been a *bet* that advanced the
        // round and cleared the stamp entirely.
        const current = await this.sessions.findOneOrFail({
          where: { id: session.id },
        });
        if (current.currentIndex === session.currentIndex) {
          session.currentServedAt = current.currentServedAt;
        } else {
          // A bet, not another GET, won the race. Everything already resolved
          // above belongs to the old index, so continuing would hand the client
          // an already-played item as the current round. Restart from the new
          // authoritative row (which will also report completion correctly).
          if (attempt >= MAX_ROUND_RESTARTS) {
            this.logger.warn(
              `Gave up re-reading session ${session.id} after ` +
                `${MAX_ROUND_RESTARTS} restarts; a bet keeps beating the fetch`,
            );
            throw new ConflictException(
              'This round moved on while it was being fetched — ask again',
            );
          }
          return this.getCurrentRound(
            sessionId,
            userId,
            currency,
            language,
            attempt + 1,
          );
        }
      }
    }

    const clock = this.roundClock(session);
    const copy = await this.catalog.localise(language, [item.id]);

    const grid = this.gridFor(session, item, currency);
    const span = grid.max - grid.min;

    return toDto(CurrentRoundDto, {
      sessionId: session.id,
      roundIndex: session.currentIndex,
      roundCount: session.itemIds.length,
      itemId: item.id,
      title: copy.title(item),
      conditionLine: copy.conditionLine(item),
      photoUrl: item.photoUrl,
      currency,
      sliderMinCents: grid.min,
      sliderMaxCents: grid.max,
      incrementCents: grid.increment,
      // Opens on the middle third — a legal, unremarkable starting range that
      // leaks nothing about where the answer sits.
      suggestedLoCents: this.pricing.snap(
        grid.min + span * 0.35,
        grid.min,
        grid.max,
      ),
      suggestedHiCents: this.pricing.snap(
        grid.min + span * 0.65,
        grid.min,
        grid.max,
      ),
      totalScore: session.totalScore,
      roundSeconds: this.app.roundSeconds,
      // Both, because they answer different questions. `expiresAt` is the
      // server's own deadline, for anything that wants to reason about it;
      // `remainingMs` is what a client should actually count down from, because
      // it costs the client no assumption about its own clock being right.
      expiresAt: clock.expiresAt,
      remainingMs: clock.remainingMs,
      opponentUsername: session.matchId
        ? await this.matches.opponentUsername(session.matchId, userId)
        : null,
      // Dealt with the round, not fetched once and cached, so the curve a
      // player is shown is always the one their bet will be scored against —
      // including across a deploy that retunes it mid-session.
      multiplierCurve: this.scoring.curveFor(),
    });
  }

  /**
   * Where the round stands against the shot clock, measured in server time
   * only. A client never sends a timestamp, so there is nothing for it to lie
   * about — which is the point.
   */
  private roundClock(session: GameSession): {
    expiresAt: Date | null;
    remainingMs: number | null;
    elapsedMs: number | null;
    expired: boolean;
  } {
    const servedAt = session.currentServedAt;
    // Stored in an `int` column, and an abandoned round resumed a month later
    // would overflow one. Capped rather than widened: past a day the exact
    // figure says nothing the cap does not, and every use of it is a comparison
    // against ten seconds.
    const elapsedSince = (from: Date) =>
      Math.min(Math.max(0, Date.now() - from.getTime()), MAX_ELAPSED_MS);

    if (this.app.roundSeconds <= 0 || !servedAt) {
      return {
        expiresAt: null,
        remainingMs: null,
        elapsedMs: servedAt ? elapsedSince(servedAt) : null,
        expired: false,
      };
    }

    const limitMs = this.app.roundSeconds * 1000;
    const elapsedMs = elapsedSince(servedAt);
    return {
      expiresAt: new Date(servedAt.getTime() + limitMs),
      remainingMs: Math.max(0, limitMs - elapsedMs),
      elapsedMs,
      // The grace is deliberately not part of `remainingMs`: the client counts
      // down to zero and submits there, and the slack exists to cover that
      // bet's flight rather than to be spent as thinking time.
      expired: elapsedMs > limitMs + this.app.roundGraceMs,
    };
  }

  /**
   * The transactional core. Everything that must not interleave happens under
   * one pessimistic lock on the session row. PostgreSQL-authoritative
   * leaderboard and match state joins the same transaction; only recoverable
   * Redis and socket delivery happens after the commit.
   */
  async placeBet(
    sessionId: string,
    userId: number,
    roundIndex: number,
    dto: PlaceBetDto,
    language: Language = DEFAULT_LANGUAGE,
  ): Promise<RevealResponseDto> {
    const completedEvents: SessionCompletedEvent[] = [];
    const matchUpdates: Array<{
      event: BetPlacedEvent;
      result: MatchReconciliation | null;
    }> = [];

    const result = await this.dataSource.transaction(async (manager) => {
      const sessionRepo = manager.getRepository(GameSession);

      // 1. Serialise concurrent submits on this session.
      const session = await sessionRepo.findOne({
        where: { id: sessionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!session) throw new NotFoundException('Session not found');
      if (session.userId !== userId) {
        throw new ForbiddenException('This is not your session');
      }
      if (roundIndex < 0 || roundIndex >= session.itemIds.length) {
        throw new BadRequestException('No such round in this session');
      }

      const currency = dto.currency ?? DEFAULT_CURRENCY;
      const itemId = session.itemIds[roundIndex];
      const item = await manager.getRepository(Item).findOneOrFail({
        where: { id: itemId },
      });
      // Read inside the transaction like the item it belongs to. Nothing writes
      // `item_copy` outside the import, so this cannot contend — it is here to
      // keep the prose and the price that reach the player from being read at
      // two different moments.
      const copy = await this.localiseWith(manager, language, [itemId]);

      // A replay of an already-scored round returns the stored result rather
      // than scoring it twice.
      const stored = await manager.getRepository(SessionRound).findOne({
        where: { sessionId, roundIndex },
      });
      if (stored) {
        return this.buildReveal(session, stored, item, true, currency, copy);
      }

      if (session.status !== SessionStatus.ACTIVE) {
        throw new ConflictException('This session is already finished');
      }
      if (roundIndex !== session.currentIndex) {
        throw new ConflictException(
          `Out of order: expected round ${session.currentIndex}`,
        );
      }

      // 2. Read the clock before anything else. A round that ran out of time is
      //    no longer being validated — it is being closed — so the checks below
      //    are skipped rather than allowed to 400 a player out of a round they
      //    can never place a legal bet on again.
      const clock = this.roundClock(session);
      if (!clock.expired) {
        // Validate the bet on the slider the player was actually given — the
        // item's own, expressed in the currency they bet in.
        this.validateBet(dto, item, session, currency);
      }
      // Then bring it back to the dollars everything downstream is denominated
      // in. Clamped, which is what makes the expired path above safe.
      const bet = this.toUsdBet(dto, session, item, currency);

      // 3. Score. Pure, no I/O.
      const themeBonusPct = session.themeId
        ? (await this.catalog.getThemeById(session.themeId)).bonusPct
        : 0;

      const bounds = this.boundsFor(session, item);
      const scored = this.scoring.score({
        truePriceCents: item.truePriceCents,
        loCents: bet.loCents,
        hiCents: bet.hiCents,
        sliderMinCents: bounds.sliderMinCents,
        sliderMaxCents: bounds.sliderMaxCents,
        themeBonusPct,
      });

      // Out of time scores nothing, however good the range was. The multiplier
      // survives because the player was shown it — the same reasoning that
      // keeps it on a miss.
      const outcome = clock.expired
        ? { ...scored, hit: false, basePoints: 0, points: 0 }
        : scored;

      // 4. Insert the round. The composite PK is the idempotency key.
      const round = manager.getRepository(SessionRound).create({
        sessionId,
        roundIndex,
        itemId,
        loCents: bet.loCents,
        hiCents: bet.hiCents,
        multiplier: outcome.multiplier,
        basePoints: outcome.basePoints,
        points: outcome.points,
        hit: outcome.hit,
        timedOut: clock.expired,
        elapsedMs: clock.elapsedMs,
        errorPct: outcome.errorPct,
        scoringVersion: outcome.scoringVersion,
      });

      try {
        await manager.getRepository(SessionRound).insert(round);
      } catch (error) {
        if (isPgError(error, PG_UNIQUE_VIOLATION)) {
          const winner = await manager
            .getRepository(SessionRound)
            .findOneOrFail({
              where: { sessionId, roundIndex },
            });
          return this.buildReveal(session, winner, item, true, currency, copy);
        }
        throw error;
      }

      // 5. Advance the session.
      session.totalScore += outcome.points;
      session.currentIndex += 1;
      session.currentServedAt = null;

      // 6. Close it out on the last round.
      const isComplete = session.currentIndex >= session.itemIds.length;
      if (isComplete) {
        session.status = SessionStatus.COMPLETE;
        session.completedAt = new Date();
      }
      await sessionRepo.save(session);

      await this.updatePlayerStats(manager, userId, outcome.points);

      let leaderboardEligible = true;
      if (isComplete && session.mode === GameMode.DAILY && session.dailyDate) {
        // Joins this transaction rather than opening its own — see the note on
        // `registerDailyPlay`; a second connection would deadlock on the row
        // `updatePlayerStats` just locked.
        await this.users.registerDailyPlay(userId, session.dailyDate, manager);
        // The source-of-truth leaderboard row commits atomically with the final
        // bet. The post-commit listener only mirrors it into Redis.
        leaderboardEligible = await this.users.isLeaderboardEligible(
          userId,
          new Date(),
          manager,
        );
        if (leaderboardEligible) {
          await this.leaderboard.persistDailyScore(
            userId,
            session.dailyDate,
            session.totalScore,
            manager,
          );
        }
      }

      const betEvent = new BetPlacedEvent(
        session.id,
        userId,
        session.mode,
        session.matchId,
        roundIndex,
        outcome.points,
        outcome.hit,
        session.totalScore,
        isComplete,
      );

      if (session.mode === GameMode.H2H && session.matchId) {
        const matchResult = await this.matchReconciliation.reconcileRound(
          session.matchId,
          roundIndex,
          manager,
        );
        matchUpdates.push({ event: betEvent, result: matchResult });
      }

      // 7. Defer recoverable serving-layer updates until after the commit.
      if (isComplete) {
        completedEvents.push(
          new SessionCompletedEvent(
            session.id,
            userId,
            session.mode,
            session.matchId,
            session.dailyDate,
            session.totalScore,
            leaderboardEligible,
          ),
        );
      }

      return this.buildReveal(session, round, item, false, currency, copy);
    });

    for (const update of matchUpdates) {
      this.matchReconciliation.publishAfterCommit(update.event, update.result);
    }
    for (const event of completedEvents) {
      // Await the rebuildable Redis mirror so requests and application
      // shutdown never leave an unobserved listener promise behind. The
      // listener catches its own failures; PostgreSQL already committed.
      await this.events.emitAsync(SESSION_COMPLETED, event);
    }

    if (result.match === null && result.round) {
      // Head-to-head reveals carry the opponent block; solo ones do not.
      const session = await this.sessions.findOne({ where: { id: sessionId } });
      if (session?.matchId) {
        result.match = await this.matches.opponentState(
          session.matchId,
          userId,
          result.round.roundIndex,
        );
      }
    }

    return result;
  }

  /**
   * The slider this round is played on, in dollars.
   *
   * Drawn rather than stored, so an item a player has seen before does not come
   * back on the scale they remember. Deterministic in the session's shared-fate
   * scope — see `sliderSeed` for why that is the seed and not the session id.
   *
   * Every read of the bounds goes through here. They are consulted three times
   * on the way through a round (dealing it, clamping the bet, scoring it), and
   * a bet clamped to one scale but scored against another is a wrong result
   * nobody would see.
   */
  private boundsFor(session: GameSession, item: Item): SliderBounds {
    return deriveSlider(
      item.truePriceCents,
      sliderSeed(session, item.id, this.app.sliderSeedSecret),
    );
  }

  /**
   * The slider one item is played on, in one currency.
   *
   * The increment is derived from the *converted* span rather than converted
   * itself, so a euro round snaps to round euro amounts instead of to the
   * fractional shadow of a dollar step.
   */
  private gridFor(
    session: GameSession,
    item: Item,
    currency: Currency,
  ): { min: number; max: number; increment: number } {
    const bounds = this.boundsFor(session, item);
    const min = this.currency.fromUsdCents(bounds.sliderMinCents, currency);
    const max = this.currency.fromUsdCents(bounds.sliderMaxCents, currency);
    return { min, max, increment: this.pricing.incrementFor(min, max) };
  }

  /**
   * The bet in dollars, which is the only denomination scoring and storage
   * know. Clamped back into the item's own bounds because converting rounds to
   * the nearest cent in each direction, and a bet sitting exactly on the top of
   * a euro slider can round to a dollar above the dollar one — a difference of
   * one cent that `scoreRound` would otherwise see as a bet off the scale.
   *
   * Dollar bets are clamped too, though validation has already put them inside
   * the slider on every path that runs it. The exception is the one that
   * matters: a bet that arrived after the deadline is recorded without being
   * validated, and this is what keeps that row scorable and storable.
   */
  private toUsdBet(
    dto: PlaceBetDto,
    session: GameSession,
    item: Item,
    currency: Currency,
  ): { loCents: number; hiCents: number } {
    const bounds = this.boundsFor(session, item);

    const toUsd = (value: number) =>
      currency === DEFAULT_CURRENCY
        ? value
        : this.currency.toUsdCents(value, currency);

    const clamp = (value: number) =>
      Math.min(
        bounds.sliderMaxCents,
        Math.max(bounds.sliderMinCents, toUsd(value)),
      );

    let loCents = clamp(dto.loCents);
    let hiCents = clamp(dto.hiCents);

    // A one-cent bet is still a bet; a zero-width one is a division by zero in
    // the centre-accuracy term, and the row's CHECK constraint refuses it. The
    // step is taken inwards from whichever end has room, so the widened bet is
    // still on the slider.
    if (loCents >= hiCents) {
      if (loCents < bounds.sliderMaxCents) {
        hiCents = loCents + 1;
      } else {
        hiCents = bounds.sliderMaxCents;
        loCents = hiCents - 1;
      }
    }
    return { loCents, hiCents };
  }

  private validateBet(
    dto: PlaceBetDto,
    item: Item,
    session: GameSession,
    currency: Currency,
  ): void {
    const { loCents, hiCents } = dto;
    const grid = this.gridFor(session, item, currency);

    if (loCents >= hiCents) {
      throw new BadRequestException('loCents must be below hiCents');
    }

    // Dollars are the stored unit, so their grid is exact and the original
    // contract holds: a bet lands on a stop or it is refused.
    if (currency === DEFAULT_CURRENCY) {
      if (loCents < grid.min || hiCents > grid.max) {
        throw new BadRequestException('Bet falls outside the slider bounds');
      }
      if (
        !this.pricing.isSnapped(loCents, grid.min, grid.max) ||
        !this.pricing.isSnapped(hiCents, grid.min, grid.max)
      ) {
        throw new BadRequestException('Bet must land on the slider increment');
      }
      return this.enforceDwell(session);
    }

    // Every other currency is derived from a live rate, and that rate can be
    // refreshed between dealing the round and receiving the bet — which moves
    // both the bounds and the stops the player was snapping to. Requiring an
    // exact stop would reject an honest bet for a market move the player never
    // saw, and it protects nothing: an unsnapped bet scores no differently
    // from the stop beside it. What still has to hold is that the bet is on
    // the slider, so the bounds are checked with a stop of slack on each side
    // and `toUsdBet` clamps whatever is left.
    if (
      loCents < grid.min - grid.increment ||
      hiCents > grid.max + grid.increment
    ) {
      throw new BadRequestException('Bet falls outside the slider bounds');
    }

    return this.enforceDwell(session);
  }

  /**
   * The floor under the shot clock's ceiling: an optional minimum time on the
   * round, cheap insurance against scripted play. Off by default.
   */
  private enforceDwell(session: GameSession): void {
    // A bet on a round the server never dealt has no clock on it at all, which
    // is the one way to sidestep both the floor and the deadline. Refused
    // whenever either is armed.
    if (this.app.roundSeconds > 0 || this.app.minRoundSeconds > 0) {
      if (!session.currentServedAt) {
        throw new BadRequestException('Load the round before placing a bet');
      }
    }

    if (this.app.minRoundSeconds > 0 && session.currentServedAt) {
      const elapsed = (Date.now() - session.currentServedAt.getTime()) / 1000;
      if (elapsed < this.app.minRoundSeconds) {
        throw new BadRequestException('Take a moment to look at the item');
      }
    }
  }

  /**
   * "Best round +480" on Home is the best *single* round — the app calls one
   * item a round ("Round 3 of 5"), so that is what the field means. Written as
   * an in-place expression so it stays correct under concurrency without
   * re-reading the row.
   */
  private async updatePlayerStats(
    manager: EntityManager,
    userId: number,
    points: number,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(User)
      .set({
        totalPoints: () => '"totalPoints" + :points',
        bestRoundScore: () => 'GREATEST("bestRoundScore", :points)',
      })
      .where('id = :userId', { userId })
      .setParameter('points', points)
      .execute();
  }

  /**
   * `CatalogService.localise`, but on the transaction's own manager.
   *
   * The service's repository is bound to the default connection and would read
   * outside the lock this method holds. Duplicated rather than plumbed through
   * because passing a manager into `CatalogService` would make every one of its
   * reads look transactional when only this one is.
   */
  private async localiseWith(
    manager: EntityManager,
    language: Language,
    itemIds: number[],
  ): Promise<LocalisedCopy> {
    if (language === DEFAULT_LANGUAGE) {
      return {
        title: (item) => item.title,
        conditionLine: (item) => item.conditionLine,
      };
    }

    const rows = await manager.getRepository(ItemCopy).find({
      where: { itemId: In(itemIds), locale: language },
    });
    const byId = new Map(rows.map((row) => [row.itemId, row]));
    return {
      title: (item) => byId.get(item.id)?.title ?? item.title,
      conditionLine: (item) =>
        byId.get(item.id)?.conditionLine ?? item.conditionLine,
    };
  }

  private buildReveal(
    session: GameSession,
    round: SessionRound,
    item: Item,
    replayed: boolean,
    currency: Currency,
    copy: LocalisedCopy,
  ): RevealResponseDto {
    // On both paths `currentIndex` already points past the round being
    // revealed — it was advanced in this transaction, or on the original bet.
    const nextIndex = session.currentIndex;
    const isComplete = nextIndex >= session.itemIds.length;
    const grid = this.gridFor(session, item, currency);

    return toDto(RevealResponseDto, {
      sessionId: session.id,
      round: this.toRoundResult(round, item, currency, copy),
      currency,
      sliderMinCents: grid.min,
      sliderMaxCents: grid.max,
      totalScore: session.totalScore,
      nextRoundIndex: isComplete ? null : nextIndex,
      isSessionComplete: session.status === SessionStatus.COMPLETE,
      replayed,
      match: null,
    });
  }

  private toRoundResult(
    round: SessionRound,
    item: Item,
    currency: Currency,
    copy: LocalisedCopy,
  ): RoundResultDto {
    // Distance from the price to the bet, rather than a branch on `hit`: a
    // round that timed out is not a hit even when the range contained the
    // price, and reading `hit` there would report a negative miss.
    const missedByCents = Math.max(
      0,
      round.loCents - item.truePriceCents,
      item.truePriceCents - round.hiCents,
    );
    const show = (usdCents: number) =>
      this.currency.fromUsdCents(usdCents, currency);

    return toDto(RoundResultDto, {
      roundIndex: round.roundIndex,
      itemId: item.id,
      title: copy.title(item),
      loCents: show(round.loCents),
      hiCents: show(round.hiCents),
      truePriceCents: show(item.truePriceCents),
      hit: round.hit,
      timedOut: round.timedOut,
      elapsedMs: round.elapsedMs,
      missedByCents: show(missedByCents),
      basePoints: round.basePoints,
      multiplier: round.multiplier,
      points: round.points,
      errorPct: round.errorPct,
    });
  }

  // --- summary ------------------------------------------------------------

  async getSummary(
    sessionId: string,
    userId: number,
    currency: Currency = DEFAULT_CURRENCY,
    language: Language = DEFAULT_LANGUAGE,
  ): Promise<SessionSummaryDto> {
    const session = await this.getOwnedSession(sessionId, userId);

    const rounds = await this.rounds.find({
      where: { sessionId },
      order: { roundIndex: 'ASC' },
    });
    const items = await this.catalog.findItemsInOrder(session.itemIds);
    const itemById = new Map(items.map((item) => [item.id, item]));
    const copy = await this.catalog.localise(language, session.itemIds);

    const results = rounds
      .map((round) => {
        const item = itemById.get(round.itemId);
        return item ? this.toRoundResult(round, item, currency, copy) : null;
      })
      .filter((result): result is RoundResultDto => result !== null);

    const hits = results.filter((r) => r.hit).length;
    const avgErrorPct = results.length
      ? results.reduce((sum, r) => sum + Math.abs(r.errorPct), 0) /
        results.length
      : 0;

    const isRankedDaily =
      session.mode === GameMode.DAILY &&
      session.status === SessionStatus.COMPLETE &&
      !!session.dailyDate;

    const standing = isRankedDaily
      ? await this.leaderboard.getDailyStanding(userId, session.dailyDate!)
      : null;
    // Places moved since yesterday's final standings; null with no yesterday.
    const rankDelta = standing
      ? await this.leaderboard.rankDelta(
          userId,
          session.dailyDate!,
          standing.rank,
        )
      : null;

    // Only ever false on a finished daily, and only for an account still inside
    // its probation window. Reported rather than left to be inferred from a
    // null percentile: an account too new to be ranked and a board that has not
    // answered yet both produce no number, and the player deserves to be told
    // which of the two happened to them rather than quietly vanishing from a
    // leaderboard they just earned a place on.
    const leaderboardEligible =
      !isRankedDaily || (await this.users.isLeaderboardEligible(userId));

    return toDto(SessionSummaryDto, {
      sessionId: session.id,
      mode: session.mode,
      status: session.status,
      hits,
      roundCount: session.itemIds.length,
      avgErrorPct,
      totalScore: session.totalScore,
      currency,
      rounds: results,
      percentile: standing?.percentile ?? null,
      rank: standing?.rank ?? null,
      sharedWith: standing?.sharedWith ?? 0,
      rankDelta,
      leaderboardEligible,
      shareText: buildShareText(session, results, hits, this.app.publicOrigin),
      match: session.matchId
        ? await this.matches.opponentState(session.matchId, userId, null)
        : null,
    });
  }

  // --- helpers ------------------------------------------------------------

  async getOwnedSession(
    sessionId: string,
    userId: number,
  ): Promise<GameSession> {
    const session = await this.sessions.findOne({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');
    if (session.userId !== userId) {
      // Deliberately not a 404: the caller supplied a valid id they do not own.
      throw new ForbiddenException('This is not your session');
    }
    return session;
  }

  /** Home's "Continue · round 3" card. */
  async findActiveDaily(userId: number): Promise<GameSession | null> {
    return this.sessions.findOne({
      where: { userId, mode: GameMode.DAILY, dailyDate: todayUtc() },
    });
  }

  private async toSessionDto(
    session: GameSession,
    resumed: boolean,
  ): Promise<SessionDto> {
    const theme = session.themeId
      ? await this.catalog.getThemeById(session.themeId)
      : null;

    return toDto(SessionDto, {
      id: session.id,
      mode: session.mode,
      status: session.status,
      currentIndex: session.currentIndex,
      roundCount: session.itemIds.length,
      totalScore: session.totalScore,
      themeSlug: theme?.slug ?? null,
      themeName: theme?.name ?? null,
      matchId: session.matchId,
      resumed,
    });
  }
}
