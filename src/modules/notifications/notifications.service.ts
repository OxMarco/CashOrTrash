import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

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
import { PushSendResult, PushSender } from './push-sender';

/** Local hour we aim for when nudging about tomorrow's challenge. */
const NUDGE_LOCAL_HOUR = 19;

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

  async deactivateForUser(userId: number): Promise<void> {
    await this.tokens.update({ userId }, { active: false });
  }

  /**
   * Runs hourly and only nudges the timezone buckets for which it is currently
   * the target local hour — so the job is cheap to run often and each player
   * hears from us once.
   */
  async sendDailyNudges(now: Date = new Date()): Promise<number> {
    const offsets = this.offsetsAtLocalHour(now, NUDGE_LOCAL_HOUR);
    if (offsets.length === 0) return 0;

    const tokens = await this.tokens.find({
      where: { active: true, timezoneOffsetMinutes: In(offsets) },
    });
    if (tokens.length === 0) return 0;

    const byUser = new Map<number, PushToken[]>();
    for (const token of tokens) {
      byUser.set(token.userId, [...(byUser.get(token.userId) ?? []), token]);
    }

    const played = await this.usersWhoPlayedToday([...byUser.keys()]);
    let sent = 0;
    let failed = 0;

    for (const [userId, userTokens] of byUser) {
      const hasPlayed = played.has(userId);
      const user = await this.users.findOne({ where: { id: userId } });
      if (!user) continue;

      const streakAtRisk =
        !hasPlayed &&
        user.streakDays > 0 &&
        user.streakLastPlayedOn === addDays(todayUtc(now), -1);

      // Nothing useful to say to someone who has already played and has no
      // streak on the line.
      if (hasPlayed && !streakAtRisk) continue;

      const kind: NudgeKind = streakAtRisk ? 'streak_at_risk' : 'daily_ready';

      // One send per language this player's devices are set up in, rather than
      // one per player. A phone in Italian and a tablet in English belong to
      // the same account and want different words, and grouping by language is
      // what stops a second device from silently deciding the first one's.
      const byLocale = new Map<string, PushToken[]>();
      for (const token of userTokens) {
        byLocale.set(token.locale, [
          ...(byLocale.get(token.locale) ?? []),
          token,
        ]);
      }

      for (const [locale, localeTokens] of byLocale) {
        const message = {
          ...nudgeCopy(kind, locale, { days: user.streakDays }),
          data: { kind },
        };

        // One player's delivery must not end the sweep. This runs per user, so
        // an exception escaping here would abandon everyone after them and fail
        // the job — and a failed job is retried whole, re-notifying every player
        // it had already reached. A push nobody receives is a missed nudge; a
        // push sent twice is the thing people uninstall over.
        let result: PushSendResult;
        try {
          result = await this.sender.send(localeTokens, message);
        } catch (error) {
          failed += localeTokens.length;
          this.logger.warn(
            `Could not nudge user ${userId} in ${locale}: ` +
              (error instanceof Error ? error.message : String(error)),
          );
          continue;
        }

        sent += result.sent;
        failed += result.failed;

        for (const invalid of result.invalidTokens) {
          await this.deactivate(invalid);
        }
      }
    }

    this.logger.log(
      `Daily nudge: ${sent} notification(s)` +
        (failed > 0 ? `, ${failed} undelivered` : ''),
    );
    return sent;
  }

  private async usersWhoPlayedToday(userIds: number[]): Promise<Set<number>> {
    if (userIds.length === 0) return new Set();

    const rows = await this.sessions.find({
      where: {
        userId: In(userIds),
        mode: GameMode.DAILY,
        dailyDate: todayUtc(),
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
