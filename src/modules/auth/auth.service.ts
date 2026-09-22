import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { ThrottlerException } from '@nestjs/throttler';

import { toDto } from 'src/common/serialization/to-dto';
import { todayUtc } from 'src/common/utils/date.util';
import { AppConfig, AuthConfig } from 'src/config/configuration';
import { AppRedis } from 'src/redis/redis-commands';
import { REDIS_CLIENT } from 'src/redis/redis.constants';
import { hashDeviceId } from '../users/device-id';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { TokenType } from './auth.types';
import { AccessTokenDto } from './dto/anonymous-auth.dto';

const DAY_SECONDS = 24 * 60 * 60;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly auth: AuthConfig;
  private readonly app: AppConfig;

  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    @Inject(REDIS_CLIENT) private readonly redis: AppRedis,
    config: ConfigService,
  ) {
    this.auth = config.getOrThrow<AuthConfig>('auth');
    this.app = config.getOrThrow<AppConfig>('app');
  }

  /**
   * There is no password to get wrong: the device id *is* the credential.
   * That is a deliberate v1 tradeoff — the game holds no personal data and
   * onboarding friction costs more than the threat model does.
   *
   * What it does cost is a leaderboard, if left alone. The board's defence
   * against a throwaway account is a 24-hour age gate, which a farm defeats by
   * registering the day before it needs them; the per-minute throttle on this
   * route only stops that being done in one burst. So minting — and only
   * minting — is budgeted per address over the same window the age gate cares
   * about. A returning device costs nothing, which is the common case and the
   * one that must never be refused.
   */
  async authenticateDevice(
    deviceId: string,
    registrationIp: string | null = null,
  ): Promise<AccessTokenDto> {
    const existing = await this.users.findByDeviceId(deviceId);
    if (existing) return this.issue(existing, false);

    await this.enforceMintingBudget(registrationIp, deviceId);

    const { user, created } = await this.users.findOrCreateByDeviceId(
      deviceId,
      registrationIp,
    );
    return this.issue(user, created);
  }

  /**
   * Counts accounts created from one address in one UTC day.
   *
   * Deliberately soft on failure: if Redis is unreachable this lets the
   * registration through rather than locking new players out of the game over a
   * cache outage. The budget is a nuisance to a farm, not a security boundary,
   * and it should not be able to take onboarding down with it.
   */
  private async enforceMintingBudget(
    ip: string | null,
    deviceId: string,
  ): Promise<void> {
    if (this.app.accountsPerIpPerDay <= 0 || !ip) return;

    // Deliberately not `auth:mint:` — that name holds INCR counters written by
    // the previous release, and SISMEMBER against a string returns WRONGTYPE.
    // The catch below fails open, so reusing the name would silently disable
    // the budget for every already-seen address until the counters expired.
    const key = `auth:mintset:${ip}:${todayUtc()}`;
    // The device id is a credential. Redis only needs a stable equality key,
    // so retain its digest rather than another copy of the credential itself —
    // the same digest the `user` row stores, from the same function.
    const device = hashDeviceId(deviceId);
    let reserved: boolean;
    try {
      reserved =
        Number(
          await this.redis.reserveDistinctDevice(
            key,
            device,
            this.app.accountsPerIpPerDay,
            DAY_SECONDS,
          ),
        ) === 1;
    } catch (error) {
      this.logger.warn(
        'Could not check an account-minting budget: ' +
          (error instanceof Error ? error.message : String(error)),
      );
      return;
    }

    if (!reserved) {
      this.logger.warn('Account-minting budget exhausted');
      throw new ThrottlerException('Too many new accounts from this network');
    }
  }

  private async issue(
    user: User,
    isNewPlayer: boolean,
  ): Promise<AccessTokenDto> {
    // The TTLs are `<digits><s|m|h|d>` strings; the Joi schema enforces the
    // shape at boot, so this cast into jsonwebtoken's template union is safe.
    const ttl = (value: string) => value as JwtSignOptions['expiresIn'];

    const accessToken = await this.jwt.signAsync(
      {
        sub: String(user.id),
        typ: TokenType.ACCESS,
        username: user.username,
      },
      { secret: this.auth.accessSecret, expiresIn: ttl(this.auth.accessTtl) },
    );

    return toDto(AccessTokenDto, {
      accessToken,
      expiresIn: ttlToSeconds(this.auth.accessTtl),
      isNewPlayer,
      username: user.username,
    });
  }
}

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

/** Mirrors the `expiresIn` string we hand jsonwebtoken, for the client's clock. */
export const ttlToSeconds = (ttl: string): number => {
  const match = /^(\d+)([smhd])?$/.exec(ttl.trim());
  if (!match) return 0;
  return Number.parseInt(match[1], 10) * (UNITS[match[2] ?? 's'] ?? 1);
};
