import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { AuthenticatedUser } from 'src/common/decorators/current-user.decorator';
import { AuthConfig } from 'src/config/configuration';
import { UsersService } from 'src/modules/users/users.service';
import { TokenType, AccessTokenPayload } from '../auth.types';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly users: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<AuthConfig>('auth').accessSecret,
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    if (payload.typ !== TokenType.ACCESS) {
      throw new UnauthorizedException('Access token required');
    }

    const id = Number(payload.sub);
    // Existence only — the id and handle both come off the verified token, so
    // there is nothing on the row this needs. `stillExists` answers from a
    // short-lived shared cache, which is what keeps a database read off the
    // front of every authenticated request in the API.
    if (!Number.isSafeInteger(id) || !(await this.users.stillExists(id))) {
      throw new UnauthorizedException('Player no longer exists');
    }

    return { id, username: payload.username ?? null };
  }
}
