import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';

import { toDto } from 'src/common/serialization/to-dto';
import { AuthConfig } from 'src/config/configuration';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { TokenType, RefreshTokenPayload } from './auth.types';
import { TokenPairDto } from './dto/anonymous-auth.dto';

@Injectable()
export class AuthService {
  private readonly auth: AuthConfig;

  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.auth = config.getOrThrow<AuthConfig>('auth');
  }

  /**
   * There is no password to get wrong: the device id *is* the credential.
   * That is a deliberate v1 tradeoff — the game holds no personal data and
   * onboarding friction costs more than the threat model does.
   */
  async authenticateDevice(deviceId: string): Promise<TokenPairDto> {
    const { user, created } = await this.users.findOrCreateByDeviceId(deviceId);
    return this.issue(user, created);
  }

  async refresh(refreshToken: string): Promise<TokenPairDto> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(refreshToken, {
        secret: this.auth.refreshSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (payload.typ !== TokenType.REFRESH) {
      throw new UnauthorizedException('Refresh token required');
    }

    const user = await this.users.findById(Number(payload.sub));
    if (!user) {
      throw new UnauthorizedException('Unknown player');
    }

    return this.issue(user, false);
  }

  private async issue(user: User, isNewPlayer: boolean): Promise<TokenPairDto> {
    // The TTLs are `<digits><s|m|h|d>` strings; the Joi schema enforces the
    // shape at boot, so this cast into jsonwebtoken's template union is safe.
    const ttl = (value: string) => value as JwtSignOptions['expiresIn'];

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(
        {
          sub: String(user.id),
          typ: TokenType.ACCESS,
          username: user.username,
        },
        { secret: this.auth.accessSecret, expiresIn: ttl(this.auth.accessTtl) },
      ),
      this.jwt.signAsync(
        { sub: String(user.id), typ: TokenType.REFRESH },
        {
          secret: this.auth.refreshSecret,
          expiresIn: ttl(this.auth.refreshTtl),
        },
      ),
    ]);

    return toDto(TokenPairDto, {
      accessToken,
      refreshToken,
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
