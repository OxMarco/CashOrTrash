import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { AuthenticatedUser } from 'src/common/decorators/current-user.decorator';
import { AuthConfig } from 'src/config/configuration';
import { TokenType, AccessTokenPayload } from '../auth.types';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<AuthConfig>('auth').accessSecret,
    });
  }

  /**
   * Refresh tokens are signed with a different secret *and* carry a type
   * claim — either alone would do, but the pair means a refresh token can
   * never be replayed as an access token by accident.
   */
  validate(payload: AccessTokenPayload): AuthenticatedUser {
    if (payload.typ !== TokenType.ACCESS) {
      throw new UnauthorizedException('Access token required');
    }

    return { id: Number(payload.sub), username: payload.username ?? null };
  }
}
