import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { In, Repository } from 'typeorm';

import { REDIS_CLIENT } from 'src/redis/redis.constants';

import { toDto } from 'src/common/serialization/to-dto';
import { DEFAULT_LANGUAGE } from '../catalog/language.constants';
import { nudgeCopy, type NudgeKind } from './nudge-copy';
import { addDays, todayUtc } from 'src/common/utils/date.util';
import {
  GameMode,
  GameSession,
  SessionStatus,
} from '../sessions/entities/game-session.entity';
import { User } from '../users/entities/user.entity';
import { PushRegistrationDto, RegisterPushTokenDto } from './dto/push.dto';
import { PushToken } from './entities/push-token.entity';
import {
  PushDelivery,
  PushSendResult,
  PushSender,
  PushTicket,
} from './push-sender';

/** Local hour we aim for when nudging about tomorrow's challenge. */
const NUDGE_LOCAL_HOUR = 19;

/**
 * Tickets awaiting a receipt: a hash of ticket id → `{ token, sentAt }`.
 *
 * Redis rather than a table because it is a queue of questions, not a record
 * of anything — every entry is deleted within a day, and losing the lot to a
 * Redis wipe costs one sweep's worth of dead tokens being found a day late,
 * on their next failed send.
 */
const TICKETS_KEY = 'push:tickets';

/**
 * How old a ticket must be before its receipt is asked for. Expo says receipts
 * are generally ready within fifteen minutes; asking sooner mostly returns
 * nothing and costs a request.
 */
const RECEIPT_DELAY_MS = 15 * 60 * 1000;

/**
 * How long Expo keeps a receipt. A ticket still unanswered after this never
 * will be, and is dropped rather than asked about forever.
 */
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

interface StashedTicket {
  token: string;
  sentAt: number;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(PushToken)
    private readonly tokens: Repository<PushToken>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(GameSession)
    private readonly sessions: Repository<GameSession>,
    private readonly sender: PushSender,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Called only after the player taps "Notify me" on the summary card — the
   * row's existence *is* the opt-in record, so we never write one on launch.
   */
  async register(
    userId: number,
    dto: RegisterPushTokenDto,
  ): Promise<PushRegistrationDto> {
    await this.tokens
      .createQueryBuilder()
      .insert()
      .into(PushToken)
      .values({
        userId,
        platform: dto.platform,
        token: dto.token,
        timezoneOffsetMinutes: dto.timezoneOffsetMinutes ?? 0,
        locale: dto.locale ?? DEFAULT_LANGUAGE,
        active: true,
      })
      // A token can migrate between users on a shared device; last writer wins.
      // `locale` is in the update list so that changing the language in the app
      // reaches the nudges — the app re-registers on launch, and a column left
      // out here would keep sending in whatever language the device was first
      // set up in.
      .orUpdate(
        ['userId', 'platform', 'timezoneOffsetMinutes', 'locale', 'active'],
        ['token'],
      )
      .execute();

    return toDto(PushRegistrationDto, {
      registered: true,
      platform: dto.platform,
    });
  }

  async deactivate(token: string): Promise<void> {
    await this.tokens.update({ token }, { active: false });
  }

  /** The same, for a whole sweep's worth of tokens the provider disowned. */
  async deactivateAll(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.tokens.update({ token: In(tokens) }, { active: false });
  }

  async deactivateForUser(userId: number): Promise<void> {
    await this.tokens.update({ userId }, { active: false });
  }

  /**
   * Runs hourly and only nudges the timezone buckets for which it is currently
   * the target local hour — so the job is cheap to run often and each player
   * hears from us once.
   *
   * Builds the whole sweep and hands it to the sender in one call, which
   * batches it at Expo's hundred-per-request limit. It used to be one request
   * per player, in series — a sweep of a few thousand players was a few
   * thousand round trips, each waiting on the last.
   */
  async sendDailyNudges(now: Date = new Date()): Promise<number> {
    const offsets = this.offsetsAtLocalHour(now, NUDGE_LOCAL_HOUR);
    if (offsets.length === 0) return 0;

    const tokens = await this.tokens.find({
      where: { active: true, timezoneOffsetMinutes: In(offsets) },
    });
    if (tokens.length === 0) return 0;

    const byUser = groupBy(tokens, (token) => token.userId);
    const userIds = [...byUser.keys()];

    // Both in one query each. A `findOne` per player inside the loop below is
    // one round trip per person nudged, on a job whose whole point is that it
    // runs against every timezone bucket every hour.
    const [played, profiles] = await Promise.all([
      this.usersWhoPlayedToday(userIds, now),
      this.usersById(userIds),
    ]);

    const deliveries: PushDelivery[] = [];
    for (const [userId, userTokens] of byUser) {
      const hasPlayed = played.has(userId);
      const user = profiles.get(userId);
      if (!user) continue;

      const streakAtRisk =
        !hasPlayed &&
        user.streakDays > 0 &&
        user.streakLastPlayedOn === addDays(todayUtc(now), -1);

      // Nothing useful to say to someone who has already played and has no
      // streak on the line.
      if (hasPlayed && !streakAtRisk) continue;

      const kind: NudgeKind = streakAtRisk ? 'streak_at_risk' : 'daily_ready';

      // Each device in its own language, rather than one message per player.
      // A phone in Italian and a tablet in English belong to the same account
      // and want different words, and choosing per device is what stops a
      // second device from silently deciding the first one's.
      for (const token of userTokens) {
        deliveries.push({
          token,
          message: {
            ...nudgeCopy(kind, token.locale, { days: user.streakDays }),
            data: { kind },
          },
        });
      }
    }
    if (deliveries.length === 0) return 0;

    // Caught, not rethrown. The sender counts a failed batch rather than
    // throwing, so reaching here is something stranger — and a failed job is
    // retried whole, re-notifying every player a delivered batch had already
    // reached. A push nobody receives is a missed nudge; a push sent twice is
    // the thing people uninstall over.
    let result: PushSendResult;
    try {
      result = await this.sender.send(deliveries);
    } catch (error) {
      this.logger.warn(
        `Daily nudge: could not send ${deliveries.length} notification(s): ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return 0;
    }

    // Collected by the sender rather than retired one at a time: a dead device
    // is not urgent, and the sweep should not spend a write per stale token.
    await this.deactivateAll(result.invalidTokens);
    await this.stashTickets(result.tickets, now);

    this.logger.log(
      `Daily nudge: ${result.sent} notification(s)` +
        (result.failed > 0 ? `, ${result.failed} undelivered` : '') +
        (result.invalidTokens.length > 0
          ? `, ${result.invalidTokens.length} device(s) retired`
          : ''),
    );
    return result.sent;
  }

  /**
   * Asks Expo what became of the nudges sent a while ago, and retires the
   * devices Apple or Google said are gone.
   *
   * The ticket a send returns only says Expo accepted the message. A device
   * that uninstalled the app is usually only reported in the receipt, so
   * without this a dead token stays `active` and is sent to — and silently
   * dropped — every evening for as long as the row exists. Scheduled half an
   * hour after the nudge (`JOB_SCHEDULES`), past the fifteen minutes Expo asks
   * callers to wait.
   */
  async checkPushReceipts(
    now: Date = new Date(),
  ): Promise<{ checked: number; retired: number }> {
    const raw = await this.redis.hgetall(TICKETS_KEY);
    const due: string[] = [];
    const expired: string[] = [];
    const tokenOf = new Map<string, string>();

    for (const [id, value] of Object.entries(raw)) {
      const stashed = parseTicket(value);
      const age = stashed ? now.getTime() - stashed.sentAt : Infinity;
      if (!stashed || age > RECEIPT_TTL_MS) {
        expired.push(id);
      } else if (age >= RECEIPT_DELAY_MS) {
        due.push(id);
        tokenOf.set(id, stashed.token);
      }
    }

    let settled: string[] = [];
    const retired: string[] = [];
    if (due.length > 0) {
      const receipts = await this.sender.receipts(due);
      settled = receipts.settled;
      for (const id of receipts.deviceNotRegistered) {
        const token = tokenOf.get(id);
        if (token) retired.push(token);
      }
      await this.deactivateAll(retired);
      if (receipts.failed > 0) {
        this.logger.warn(
          `Push receipts: ${receipts.failed} notification(s) were not delivered`,
        );
      }
    }

    // Only after the tokens are retired: a crash in between leaves the ids
    // stashed and the next check simply asks again.
    const done = [...settled, ...expired];
    if (done.length > 0) await this.redis.hdel(TICKETS_KEY, ...done);

    if (due.length > 0 || expired.length > 0) {
      this.logger.log(
        `Push receipts: ${due.length} checked, ${settled.length} answered, ` +
          `${retired.length} device(s) retired, ${expired.length} expired unanswered`,
      );
    }
    return { checked: due.length, retired: retired.length };
  }

  /**
   * Keeps the tickets for `checkPushReceipts`.
   *
   * Failure is logged, not thrown, for the reason the send is not: the
   * notifications are already out, and failing the job now would retry the
   * sweep and send them again. The cost of losing the stash is that tonight's
   * dead devices are found tomorrow instead.
   */
  private async stashTickets(tickets: PushTicket[], now: Date): Promise<void> {
    if (tickets.length === 0) return;
    const sentAt = now.getTime();
    try {
      await this.redis
        .multi()
        .hset(
          TICKETS_KEY,
          Object.fromEntries(
            tickets.map(({ id, token }) => [
              id,
              JSON.stringify({ token, sentAt } satisfies StashedTicket),
            ]),
          ),
        )
        // A backstop for the check job never running at all; in normal
        // operation every entry is removed within a day by the check itself.
        .pexpire(TICKETS_KEY, RECEIPT_TTL_MS * 2)
        .exec();
    } catch (error) {
      this.logger.warn(
        `Could not keep ${tickets.length} push ticket(s) for a receipt check: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async usersById(userIds: number[]): Promise<Map<number, User>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.users.find({ where: { id: In(userIds) } });
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async usersWhoPlayedToday(
    userIds: number[],
    now: Date,
  ): Promise<Set<number>> {
    if (userIds.length === 0) return new Set();

    const rows = await this.sessions.find({
      where: {
        userId: In(userIds),
        mode: GameMode.DAILY,
        dailyDate: todayUtc(now),
        status: SessionStatus.COMPLETE,
      },
      select: { userId: true, id: true },
    });

    return new Set(rows.map((row) => row.userId));
  }

  /**
   * Which stored UTC offsets are currently at `localHour`. Offsets are stored
   * as reported by the device, so we match on the exact set rather than
   * rounding to whole hours — India (+330) and Nepal (+345) are real.
   */
  private offsetsAtLocalHour(now: Date, localHour: number): number[] {
    const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

    const offsets: number[] = [];
    for (let offset = -720; offset <= 840; offset += 15) {
      const local = (((utcMinutes + offset) % 1440) + 1440) % 1440;
      if (Math.floor(local / 60) === localHour) offsets.push(offset);
    }
    return offsets;
  }
}

const parseTicket = (value: string): StashedTicket | null => {
  try {
    const parsed = JSON.parse(value) as Partial<StashedTicket>;
    return typeof parsed.token === 'string' && typeof parsed.sentAt === 'number'
      ? { token: parsed.token, sentAt: parsed.sentAt }
      : null;
  } catch {
    return null;
  }
};

/**
 * Buckets by key, pushing rather than rebuilding the array each time. The
 * spread-into-a-new-array idiom this replaces is quadratic in bucket size,
 * which on a sweep grouping every active token by user is not free.
 */
const groupBy = <T, K>(items: T[], keyOf: (item: T) => K): Map<K, T[]> => {
  const grouped = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(item);
    else grouped.set(key, [item]);
  }
  return grouped;
};
