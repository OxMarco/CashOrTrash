import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';

import { toDto } from 'src/common/serialization/to-dto';
import { todayUtc } from 'src/common/utils/date.util';
import { AppConfig } from 'src/config/configuration';
import { CatalogService } from '../catalog/catalog.service';
import { MYSTERY_BONUS_PCT } from '../catalog/mystery';
import { LocalisedCopy } from '../catalog/catalog.service';
import { Item } from '../catalog/entities/item.entity';
import { ItemCopy } from '../catalog/entities/item-copy.entity';
import { DEFAULT_LANGUAGE, Language } from '../catalog/language.constants';
import { deriveSlider, SliderBounds, sliderSeed } from '../catalog/slider';
import { Currency, DEFAULT_CURRENCY } from '../currency/currency.constants';
import { CurrencyService } from '../currency/currency.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { MatchesReadService } from '../matches/matches-read.service';
import {
  MatchReconciliation,
  MatchesReconciliationService,
} from '../matches/matches-reconciliation.service';
import { PricingService } from '../scoring/pricing.service';
import { ScoringService } from '../scoring/scoring.service';
import { CURRENT_SCORING } from '../scoring/constants';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  BET_OFF_SLIDER,
  ROUND_CURRENCY_MISMATCH,
  ROUND_MOVED_ON,
  ROUND_NOT_SERVED,
  ROUND_OUT_OF_ORDER,
  ROUND_TOO_FAST,
  ROUND_UNKNOWN,
  SESSION_FINISHED,
  roundProblem,
} from './round-problems';
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
import { SessionCreationService } from './session-creation.service';

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
    private readonly creation: SessionCreationService,
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
    return this.creation.createOrResume(userId, dto);
  }

  // --- gameplay -----------------------------------------------------------

  async getCurrentRound(
    sessionId: string,
    userId: number,
    /**
     * The currency the client asked for, or undefined when it expressed no
     * preference. The distinction matters: an explicit choice deals — or
     * re-deals — the round in that currency, while an absent one leaves an
     * already-dealt round on the quote it was dealt with. Collapsing the two
     * would make a parameterless prefetch pin the round to dollars and then
     * reject the player's euro bet.
     */
    currency: Currency | undefined = undefined,
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
      throw new ConflictException(
        roundProblem(SESSION_FINISHED, 'This session is already finished'),
      );
    }
    if (session.currentIndex >= session.itemIds.length) {
      throw new ConflictException(
        roundProblem(SESSION_FINISHED, 'No rounds left in this session'),
      );
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
      const dealtIn = currency ?? DEFAULT_CURRENCY;
      const exchangeRate = this.currency.rateFor(dealtIn);
      const stamped = await this.sessions.update(
        {
          id: session.id,
          status: SessionStatus.ACTIVE,
          currentIndex: session.currentIndex,
          currentServedAt: IsNull(),
        },
        {
          currentServedAt: servedAt,
          currentCurrency: dealtIn,
          currentExchangeRate: exchangeRate,
        },
      );
      if (stamped.affected === 1) {
        session.currentServedAt = servedAt;
        session.currentCurrency = dealtIn;
        session.currentExchangeRate = exchangeRate;
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
          session.currentCurrency = current.currentCurrency;
          session.currentExchangeRate = current.currentExchangeRate;
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
              roundProblem(
                ROUND_MOVED_ON,
                'This round moved on while it was being fetched — ask again',
              ),
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

    // Two cases converge here. A row created before round quotes were
    // persisted carries a deal timestamp with no currency and needs its first
    // post-deploy read to pin one. And a player who switches currency mid-round
    // re-deals it: the response below carries the new grid, so the quote it was
    // built from has to be the one a later bet is checked against. Switching is
    // not a way to buy time — `currentServedAt` is stamped once above and is
    // deliberately left alone here, so the shot clock keeps running.
    const wantsRepin =
      !session.currentCurrency ||
      !session.currentExchangeRate ||
      (currency !== undefined && currency !== session.currentCurrency);

    if (wantsRepin) {
      const target = currency ?? session.currentCurrency ?? DEFAULT_CURRENCY;
      const exchangeRate = this.currency.rateFor(target);
      // Compare-and-set on the quote this request actually read, so a
      // concurrent switch cannot be silently clobbered by a slower one.
      const quoted = await this.sessions.update(
        {
          id: session.id,
          status: SessionStatus.ACTIVE,
          currentIndex: session.currentIndex,
          currentCurrency: session.currentCurrency ?? IsNull(),
        },
        { currentCurrency: target, currentExchangeRate: exchangeRate },
      );
      if (quoted.affected === 1) {
        session.currentCurrency = target;
        session.currentExchangeRate = exchangeRate;
      } else {
        const current = await this.sessions.findOneOrFail({
          where: { id: session.id },
        });
        if (current.currentIndex !== session.currentIndex) {
          if (attempt >= MAX_ROUND_RESTARTS) {
            throw new ConflictException(
              roundProblem(
                ROUND_MOVED_ON,
                'This round moved on while it was being fetched — ask again',
              ),
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
        session.currentCurrency = current.currentCurrency;
        session.currentExchangeRate = current.currentExchangeRate;
      }
    }

    const clock = this.roundClock(session);
    const copy = await this.catalog.localise(language, [item.id]);
    const pinnedCurrency =
      session.currentCurrency ?? currency ?? DEFAULT_CURRENCY;
    const exchangeRate =
      session.currentExchangeRate ?? this.currency.rateFor(pinnedCurrency);

    const grid = this.gridFor(
      session,
      item,
      session.currentIndex,
      pinnedCurrency,
      exchangeRate,
    );
    const span = grid.max - grid.min;

    return toDto(CurrentRoundDto, {
      sessionId: session.id,
      roundIndex: session.currentIndex,
      roundCount: session.itemIds.length,
      itemId: item.id,
      title: copy.title(item),
      conditionLine: copy.conditionLine(item),
      photoUrl: item.photoUrl,
      currency: pinnedCurrency,
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
      multiplierCurve: this.scoring.curveFor(
        session.scoringVersion ?? CURRENT_SCORING.version,
      ),
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
    // Read off the locked row below rather than re-fetched after the commit.
    // Every reveal is built with `match: null` and filled in afterwards, so a
    // post-commit lookup here would run on every bet in every mode — including
    // the solo ones, which only ever learn that there was no match to fill in.
    let matchId: string | null = null;

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
      matchId = session.matchId;
      if (roundIndex < 0 || roundIndex >= session.itemIds.length) {
        throw new BadRequestException(
          roundProblem(ROUND_UNKNOWN, 'No such round in this session'),
        );
      }

      const requestedCurrency = dto.currency ?? DEFAULT_CURRENCY;
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
        const replayCurrency = stored.currency ?? requestedCurrency;
        const replayRate =
          stored.exchangeRate ?? this.currency.rateFor(replayCurrency);
        return this.buildReveal(
          session,
          stored,
          item,
          true,
          replayCurrency,
          replayRate,
          copy,
        );
      }

      if (session.status !== SessionStatus.ACTIVE) {
        throw new ConflictException(
          roundProblem(SESSION_FINISHED, 'This session is already finished'),
        );
      }
      if (roundIndex !== session.currentIndex) {
        throw new ConflictException(
          roundProblem(
            ROUND_OUT_OF_ORDER,
            `Out of order: expected round ${session.currentIndex}`,
          ),
        );
      }

      const currency = session.currentCurrency ?? requestedCurrency;
      if (
        session.currentCurrency !== null &&
        requestedCurrency !== session.currentCurrency
      ) {
        throw new BadRequestException(
          roundProblem(
            ROUND_CURRENCY_MISMATCH,
            `This round was dealt in ${session.currentCurrency}. Re-fetch it ` +
              `with ?currency=${requestedCurrency} to play it in ` +
              `${requestedCurrency}.`,
          ),
        );
      }
      // Whether the grid below comes from the quote the round was dealt with or
      // from a rate read just now. Only the pinned case can be held to exact
      // snapping — see `validateBet`.
      const quotePinned = session.currentExchangeRate !== null;
      const exchangeRate =
        session.currentExchangeRate ?? this.currency.rateFor(currency);
      session.currentCurrency = currency;
      session.currentExchangeRate = exchangeRate;

      // 2. Read the clock before anything else. A round that ran out of time is
      //    no longer being validated — it is being closed — so the checks below
      //    are skipped rather than allowed to 400 a player out of a round they
      //    can never place a legal bet on again.
      const clock = this.roundClock(session);
      if (!clock.expired) {
        // Validate the bet on the slider the player was actually given — the
        // item's own, expressed in the currency they bet in.
        this.validateBet(
          dto,
          item,
          session,
          roundIndex,
          currency,
          exchangeRate,
          quotePinned,
        );
      }
      // Then bring it back to the dollars everything downstream is denominated
      // in. Clamped, which is what makes the expired path above safe.
      const bet = this.toUsdBet(
        dto,
        session,
        item,
        roundIndex,
        currency,
        exchangeRate,
      );

      // 3. Score. Pure, no I/O.
      // A category's bonus is the number an admin set on its row. A themeless
      // round has none to read: for the mystery mix that is the constant
      // bonus the mix is played for, and for the daily — which is themeless
      // because the calendar chose the items, not because the player gave up
      // knowing them — it stays nothing.
      const themeBonusPct = session.themeId
        ? (await this.catalog.getThemeById(session.themeId)).bonusPct
        : session.mode === GameMode.DAILY
          ? 0
          : MYSTERY_BONUS_PCT;

      const bounds = this.boundsFor(session, item, roundIndex);
      const scored = this.scoring.score(
        {
          truePriceCents: item.truePriceCents,
          loCents: bet.loCents,
          hiCents: bet.hiCents,
          sliderMinCents: bounds.sliderMinCents,
          sliderMaxCents: bounds.sliderMaxCents,
          themeBonusPct,
        },
        session.scoringVersion ?? CURRENT_SCORING.version,
      );

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
        currency,
        exchangeRate,
      });

      // The locked session row serialises submits, and the stored-round check
      // above handles retries before this insert. Let an unexpected constraint
      // failure abort cleanly rather than querying inside an aborted PG tx.
      await manager.getRepository(SessionRound).insert(round);

      // 5. Advance the session.
      session.totalScore += outcome.points;
      session.currentIndex += 1;
      session.currentServedAt = null;
      session.currentCurrency = null;
      session.currentExchangeRate = null;

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

      return this.buildReveal(
        session,
        round,
        item,
        false,
        currency,
        exchangeRate,
        copy,
      );
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

    // Head-to-head reveals carry the opponent block; solo ones do not.
    if (matchId && result.match === null && result.round) {
      result.match = await this.matches.opponentState(
        matchId,
        userId,
        result.round.roundIndex,
      );
    }

    return result;
  }

  /**
   * The slider this round is played on, in dollars.
   *
   * Stored when the shared challenge or session is created, so an item a player
   * has seen before does not come back on a remembered scale and a later secret
   * rotation cannot change a round already in flight. Legacy rows fall back to
   * the deterministic shared-fate seed — see `sliderSeed`.
   *
   * Every read of the bounds goes through here. They are consulted three times
   * on the way through a round (dealing it, clamping the bet, scoring it), and
   * a bet clamped to one scale but scored against another is a wrong result
   * nobody would see.
   */
  private boundsFor(
    session: GameSession,
    item: Item,
    /**
     * The round's own position, passed in rather than recovered with
     * `itemIds.indexOf(item.id)`. The pinned bound arrays are aligned with
     * `itemIds` by index, and a lookup by id returns the *first* occurrence —
     * so a session that ever drew the same item twice would deal the second
     * round on one slider and score it on another. `drawItemIds` yields
     * distinct ids today, which makes that latent rather than live; taking the
     * index from the caller makes the alignment hold by construction instead of
     * by coincidence.
     */
    roundIndex: number,
  ): SliderBounds {
    const index = roundIndex;
    const storedMin = session.sliderMinCents?.[index];
    const storedMax = session.sliderMaxCents?.[index];
    if (
      index >= 0 &&
      index < session.itemIds.length &&
      Number.isSafeInteger(storedMin) &&
      Number.isSafeInteger(storedMax) &&
      storedMin! < storedMax!
    ) {
      return { sliderMinCents: storedMin!, sliderMaxCents: storedMax! };
    }

    // Transitional fallback for sessions created before the pinning migration.
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
    roundIndex: number,
    currency: Currency,
    exchangeRate: number = this.currency.rateFor(currency),
  ): { min: number; max: number; increment: number } {
    const bounds = this.boundsFor(session, item, roundIndex);
    const min = this.currency.fromUsdCents(
      bounds.sliderMinCents,
      currency,
      exchangeRate,
    );
    const max = this.currency.fromUsdCents(
      bounds.sliderMaxCents,
      currency,
      exchangeRate,
    );
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
    roundIndex: number,
    currency: Currency,
    exchangeRate: number,
  ): { loCents: number; hiCents: number } {
    const bounds = this.boundsFor(session, item, roundIndex);

    const toUsd = (value: number) =>
      currency === DEFAULT_CURRENCY
        ? value
        : this.currency.toUsdCents(value, currency, exchangeRate);

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

  /**
   * `quotePinned` says whether the grid was rebuilt from the quote the round
   * was dealt with, or from a rate read at this moment.
   *
   * Pinned is the ordinary case and can be held to the exact grid: the player
   * was shown these bounds and this increment, so anything off them is a bet
   * the client made up. The unpinned case is a session dealt before quotes were
   * persisted, where the rate can move between the deal and the bet and shift
   * every grid line under an honest player. There the bounds get a one-increment
   * tolerance and the snap requirement is dropped — `toUsdBet` clamps into the
   * item's own dollar bounds straight after, so a tolerated bet is still scored
   * on the slider rather than off it.
   */
  private validateBet(
    dto: PlaceBetDto,
    item: Item,
    session: GameSession,
    roundIndex: number,
    currency: Currency,
    exchangeRate: number,
    quotePinned: boolean,
  ): void {
    const { loCents, hiCents } = dto;
    const grid = this.gridFor(
      session,
      item,
      roundIndex,
      currency,
      exchangeRate,
    );

    if (loCents >= hiCents) {
      throw new BadRequestException(
        roundProblem(BET_OFF_SLIDER, 'loCents must be below hiCents'),
      );
    }

    const drifts = !quotePinned && currency !== DEFAULT_CURRENCY;
    const floor = drifts ? grid.min - grid.increment : grid.min;
    const ceiling = drifts ? grid.max + grid.increment : grid.max;

    if (loCents < floor || hiCents > ceiling) {
      throw new BadRequestException(
        roundProblem(BET_OFF_SLIDER, 'Bet falls outside the slider bounds'),
      );
    }
    if (
      !drifts &&
      (!this.pricing.isSnapped(loCents, grid.min, grid.max) ||
        !this.pricing.isSnapped(hiCents, grid.min, grid.max))
    ) {
      throw new BadRequestException(
        roundProblem(BET_OFF_SLIDER, 'Bet must land on the slider increment'),
      );
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
        throw new BadRequestException(
          roundProblem(ROUND_NOT_SERVED, 'Load the round before placing a bet'),
        );
      }
    }

    if (this.app.minRoundSeconds > 0 && session.currentServedAt) {
      const elapsed = (Date.now() - session.currentServedAt.getTime()) / 1000;
      if (elapsed < this.app.minRoundSeconds) {
        throw new BadRequestException(
          roundProblem(ROUND_TOO_FAST, 'Take a moment to look at the item'),
        );
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
    exchangeRate: number,
    copy: LocalisedCopy,
  ): RevealResponseDto {
    // On both paths `currentIndex` already points past the round being
    // revealed — it was advanced in this transaction, or on the original bet.
    const nextIndex = session.currentIndex;
    const isComplete = nextIndex >= session.itemIds.length;
    const grid = this.gridFor(
      session,
      item,
      round.roundIndex,
      currency,
      exchangeRate,
    );

    return toDto(RevealResponseDto, {
      sessionId: session.id,
      round: this.toRoundResult(round, item, currency, copy, exchangeRate),
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
    exchangeRate?: number,
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
      this.currency.fromUsdCents(usdCents, currency, exchangeRate);

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
}
