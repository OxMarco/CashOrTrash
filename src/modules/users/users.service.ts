import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource, EntityManager, LessThan, Repository } from 'typeorm';

import {
  isPgError,
  PG_UNIQUE_VIOLATION,
} from 'src/common/database/pg-error-codes';
import { addDays, todayUtc } from 'src/common/utils/date.util';
import { AppConfig } from 'src/config/configuration';
import { Item } from '../catalog/entities/item.entity';
import { ItemCopy } from '../catalog/entities/item-copy.entity';
import { DEFAULT_LANGUAGE, Language } from '../catalog/language.constants';
import { Currency } from '../currency/currency.constants';
import { CurrencyService } from '../currency/currency.service';
import {
  GameMode,
  GameSession,
  SessionStatus,
} from '../sessions/entities/game-session.entity';
import { SessionRound } from '../sessions/entities/session-round.entity';
import { User } from './entities/user.entity';
import { UsernameService, USERNAME_TAKEN } from './username.service';

/** How far into today's challenge a player is — see `DailyProgressDto`. */
export interface DailyProgress {
  challengeDate: string;
  roundsPlayed: number;
  roundCount: number;
  complete: boolean;
}

@Injectable()
export class UsersService {
  private readonly leaderboardMinAccountAgeMs: number;
  private readonly roundsPerSession: number;
  private readonly registrationIpRetentionDays: number;

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    // Read-only, and deliberately the repository rather than `SessionsService`:
    // `SessionsModule` already imports this one, so depending on it back would
    // close a cycle for one `SELECT`.
    @InjectRepository(GameSession)
    private readonly sessions: Repository<GameSession>,
    @InjectRepository(SessionRound)
    private readonly rounds: Repository<SessionRound>,
    @InjectRepository(ItemCopy)
    private readonly copies: Repository<ItemCopy>,
    private readonly currency: CurrencyService,
    private readonly usernames: UsernameService,
    private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    const app = config.getOrThrow<AppConfig>('app');
    this.leaderboardMinAccountAgeMs =
      app.leaderboardMinAccountAgeHours * 60 * 60 * 1000;
    this.roundsPerSession = app.roundsPerSession;
    this.registrationIpRetentionDays = app.registrationIpRetentionDays;
  }

  /**
   * Clears `registrationIp` on accounts past the retention window.
   *
   * Run nightly. The address is written once at signup and never read after an
   * abuse investigation that would have happened within days, so keeping it
   * beyond the window is storing personal data with no live purpose. Set to
   * null rather than deleting the row: the account is a real player.
   *
   * Bounded by the partial index on the column, so the sweep touches only rows
   * that still hold an address rather than the whole table.
   */
  async pruneRegistrationIps(now: Date = new Date()): Promise<number> {
    if (this.registrationIpRetentionDays <= 0) return 0;

    const cutoff = new Date(
      now.getTime() - this.registrationIpRetentionDays * 86_400_000,
    );

    const result = await this.users
      .createQueryBuilder()
      .update(User)
      .set({ registrationIp: null })
      .where('"registrationIp" IS NOT NULL')
      .andWhere('"createdAt" < :cutoff', { cutoff })
      .execute();

    return result.affected ?? 0;
  }

  /**
   * Progress through today's challenge, answered whether or not it is started.
   *
   * Home renders "Play", "Continue · round 3" and "View results" from this one
   * number, and it has to be the server's: the device's own copy could not see a
   * round played on another one, and was the last thing the app kept its own
   * score in.
   */
  async dailyProgress(userId: number, today: string): Promise<DailyProgress> {
    const session = await this.sessions.findOne({
      where: { userId, mode: GameMode.DAILY, dailyDate: today },
    });

    const roundCount = session?.itemIds.length ?? this.roundsPerSession;
    // `currentIndex` is the round being played, so it is also the count of the
    // rounds behind it — and it stops at `roundCount` on a finished challenge.
    const roundsPlayed = Math.min(session?.currentIndex ?? 0, roundCount);

    return {
      challengeDate: today,
      roundsPlayed,
      roundCount,
      complete: roundsPlayed >= roundCount,
    };
  }

  /**
   * The round of the player's last finished daily that got away furthest —
   * Home's "yesterday's find that got you" card.
   *
   * "Furthest" is relative to the price, not in money: a bet $90,000 off a
   * $175,000 yacht is a bigger surprise than one $90,000 off a $5m schooner,
   * and the card is there for the surprise. Timed-out rounds are skipped —
   * they say nothing about the player's eye — and a challenge with no misses
   * has nothing to show, which the card treats as absence rather than as a
   * failure. The last *finished* daily before today, whenever that was: a
   * player back after a week is shown the day they last played, not nothing.
   */
  async lastDailyMiss(
    userId: number,
    today: string,
    currency: Currency,
    language: Language = DEFAULT_LANGUAGE,
  ): Promise<LastDailyMiss | null> {
    const session = await this.sessions.findOne({
      where: {
        userId,
        mode: GameMode.DAILY,
        status: SessionStatus.COMPLETE,
        dailyDate: LessThan(today),
      },
      order: { dailyDate: 'DESC' },
    });
    if (!session?.dailyDate) return null;

    const rounds = await this.rounds.find({
      where: { sessionId: session.id, hit: false, timedOut: false },
      relations: { item: true },
    });

    let worst: { round: SessionRound; item: Item; missedBy: number } | null =
      null;
    for (const round of rounds) {
      const item = round.item;
      if (!item) continue;
      const missedByCents = Math.max(
        round.loCents - item.truePriceCents,
        item.truePriceCents - round.hiCents,
      );
      const relative = missedByCents / item.truePriceCents;
      if (relative > 0 && (!worst || relative > worst.missedBy)) {
        worst = { round, item, missedBy: relative };
      }
    }
    if (!worst) return null;

    const copy =
      language === DEFAULT_LANGUAGE
        ? null
        : await this.copies.findOne({
            where: { itemId: worst.item.id, locale: language },
          });
    const show = (usdCents: number) =>
      this.currency.fromUsdCents(usdCents, currency);

    return {
      challengeDate: session.dailyDate,
      itemId: worst.item.id,
      title: copy?.title ?? worst.item.title,
      photoUrl: worst.item.photoUrl,
      currency,
      loCents: show(worst.round.loCents),
      hiCents: show(worst.round.hiCents),
      truePriceCents: show(worst.item.truePriceCents),
    };
  }

  findById(id: number): Promise<User | null> {
    return this.users.findOne({ where: { id } });
  }

  async getById(id: number): Promise<User> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('Player not found');
    return user;
  }

  /**
   * A returning device, or null for one we have never seen.
   *
   * Split out from `findOrCreateByDeviceId` so `AuthService` can tell the two
   * cases apart before it acts: registering costs an address part of its daily
   * budget, and coming back must always be free.
   */
  findByDeviceId(deviceId: string): Promise<User | null> {
    return this.users.findOne({ where: { deviceId } });
  }

  /**
   * Two devices posting the same id concurrently must not create two players.
   * `ON CONFLICT DO NOTHING` plus a re-read makes the race resolve in the
   * database rather than in a lock we would have to maintain.
   */
  async findOrCreateByDeviceId(
    deviceId: string,
    registrationIp: string | null = null,
  ): Promise<{ user: User; created: boolean }> {
    const existing = await this.users.findOne({ where: { deviceId } });
    if (existing) return { user: existing, created: false };

    const result = await this.users
      .createQueryBuilder()
      .insert()
      .into(User)
      .values({
        deviceId,
        avatarSeed: randomBytes(8).toString('hex'),
        // Only ever written here. A returning device does not touch it, so the
        // column keeps saying where the account came from rather than where it
        // was last used — which is the question an abuse investigation asks.
        registrationIp,
      })
      .orIgnore()
      .returning('*')
      .execute();

    const inserted = result.raw?.[0] as User | undefined;
    if (inserted) return { user: inserted, created: true };

    // Lost the race — the winner's row is there now.
    const user = await this.users.findOne({ where: { deviceId } });
    if (!user) throw new ConflictException('Could not register device');
    return { user, created: false };
  }

  async isUsernameAvailable(candidate: string): Promise<boolean> {
    const count = await this.users.count({ where: { username: candidate } });
    return count === 0;
  }

  /**
   * The unique index is the arbiter. Checking first and inserting second would
   * leave a window; we let the write fail and translate the violation.
   */
  async claimUsername(userId: number, raw: string): Promise<User> {
    const check = this.usernames.check(raw);
    if (!check.ok) {
      // 400, not 409: the name is not allowed at all. A 409 would tell the
      // client someone else holds it and invite them to retry in a minute.
      // `error` becomes the problem document's `type` — the client switches on
      // that, never on the prose.
      throw new BadRequestException({
        error: this.usernames.problemCode(check.reason!),
        message: this.usernames.describe(check.reason!),
      });
    }

    const user = await this.getById(userId);
    if (user.username === check.normalised) return user;

    try {
      await this.users.update({ id: userId }, { username: check.normalised });
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION)) {
        throw new ConflictException({
          error: USERNAME_TAKEN,
          message: 'That name is already taken',
        });
      }
      throw error;
    }

    return this.getById(userId);
  }

  /**
   * Permanently removes an anonymous account and its gameplay data.
   *
   * Matches use restrictive foreign keys because an ordinary cleanup must never
   * erase an opponent's result. Account deletion is the exceptional path: the
   * affected head-to-head object and both of its sessions are removed together,
   * then the player's remaining sessions. Rows with CASCADE relations (scores,
   * friends and push tokens) leave with the user.
   */
  async deleteAccount(userId: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const [user] = await manager.query<Array<{ id: number }>>(
        'SELECT id FROM "user" WHERE id = $1 FOR UPDATE',
        [userId],
      );
      if (!user) throw new NotFoundException('Player not found');

      const matches = await manager.query<Array<{ id: string }>>(
        `SELECT id FROM "match"
          WHERE "hostUserId" = $1
             OR "guestUserId" = $1
             OR "winnerUserId" = $1
          FOR UPDATE`,
        [userId],
      );

      if (matches.length > 0) {
        const ids = matches.map((match) => match.id);
        await manager
          .createQueryBuilder()
          .delete()
          .from(GameSession)
          .where('"matchId" IN (:...ids)', { ids })
          .execute();
        await manager
          .createQueryBuilder()
          .delete()
          .from('match')
          .where('id IN (:...ids)', { ids })
          .execute();
      }

      await manager.delete(GameSession, { userId });
      await manager.delete(User, { id: userId });
    });
  }

  /**
   * Called once per completed daily session. Consecutive UTC days extend the
   * streak; a gap restarts it at 1; replaying the same day is a no-op, which
   * matters because the caller runs inside the bet transaction and may be
   * replayed by an idempotent retry.
   *
   * `manager` is not optional decoration. The bet transaction has already
   * written the player's row, so it holds a lock on it; opening a *second*
   * transaction here — on a second pooled connection — would block on that
   * lock while the first transaction blocked waiting for this call to return.
   * That is a self-deadlock on the last round of every daily, and it resolves
   * only when the pool times out. Callers already inside a transaction must
   * pass their manager so this joins it instead of racing it.
   */
  async registerDailyPlay(
    userId: number,
    playedOn: string = todayUtc(),
    manager?: EntityManager,
  ): Promise<User> {
    const run = async (entityManager: EntityManager): Promise<User> => {
      const repo = entityManager.getRepository(User);
      const user = await repo.findOne({
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user) throw new NotFoundException('Player not found');

      if (user.streakLastPlayedOn === playedOn) return user;

      const continues =
        user.streakLastPlayedOn !== null &&
        addDays(user.streakLastPlayedOn, 1) === playedOn;

      user.streakDays = continues ? user.streakDays + 1 : 1;
      user.streakLastPlayedOn = playedOn;

      return repo.save(user);
    };

    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  /**
   * A streak is only alive if the last play was today or yesterday — otherwise
   * Home would proudly display a streak the player has already lost. Read-side
   * only; the stored value is corrected on the next play.
   */
  effectiveStreak(user: User, today: string = todayUtc()): number {
    if (!user.streakLastPlayedOn) return 0;
    if (user.streakLastPlayedOn === today) return user.streakDays;
    if (addDays(user.streakLastPlayedOn, 1) === today) return user.streakDays;
    return 0;
  }

  /**
   * Anonymous installs are intentionally frictionless, but a brand-new one
   * must not be able to learn today's answers elsewhere and immediately enter
   * a perfect score. Production applies a probation window; development and
   * tests configure zero so local play remains immediate.
   */
  async isLeaderboardEligible(
    userId: number,
    now = new Date(),
    manager?: EntityManager,
  ): Promise<boolean> {
    if (this.leaderboardMinAccountAgeMs <= 0) return true;
    const repo = manager?.getRepository(User) ?? this.users;
    const user = await repo.findOne({
      where: { id: userId },
      select: { id: true, createdAt: true },
    });
    if (!user) return false;
    return (
      now.getTime() - user.createdAt.getTime() >=
      this.leaderboardMinAccountAgeMs
    );
  }
}

export interface LastDailyMiss {
  challengeDate: string;
  itemId: number;
  title: string;
  photoUrl: string;
  currency: Currency;
  loCents: number;
  hiCents: number;
  truePriceCents: number;
}
