import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { randomBytes } from 'node:crypto';

import { AdminConfig } from 'src/config/configuration';

export const ADMIN_STRATEGY = 'admin-jwt';

/** What an admin token carries. There is one operator, so there is no subject. */
export interface AdminTokenPayload {
  typ: 'admin';
}

export interface AdminPrincipal {
  admin: true;
}

/**
 * Registered under its own name alongside the player strategy, and keyed on
 * `ADMIN_JWT_SECRET` rather than `JWT_ACCESS_SECRET`.
 *
 * The separation is the point. Both strategies verify a bearer token, and a
 * single secret would mean any player token — which every install of the game
 * holds — could be replayed against the portal by changing one claim.
 *
 * The `typ` check is belt-and-braces on top of that: even given the admin
 * secret, a token minted for some other purpose is refused here.
 */
@Injectable()
export class AdminJwtStrategy extends PassportStrategy(
  Strategy,
  ADMIN_STRATEGY,
) {
  constructor(config: ConfigService) {
    const secret = config.getOrThrow<AdminConfig>('admin').jwtSecret;
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // Passport refuses to construct without a string. An unconfigured portal
      // gets an unguessable one-shot value, so every token fails to verify
      // rather than the process failing to boot.
      secretOrKey: secret || randomBytes(32).toString('hex'),
    });
  }

  validate(payload: AdminTokenPayload): AdminPrincipal {
    if (payload?.typ !== 'admin') {
      throw new UnauthorizedException('Admin token required');
    }
    return { admin: true };
  }
}
