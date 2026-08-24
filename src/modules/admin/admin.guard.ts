import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { SetMetadata } from '@nestjs/common';

import { ADMIN_STRATEGY } from './strategies/admin-jwt.strategy';

const ADMIN_PUBLIC_KEY = 'adminPublic';

/**
 * Opens one admin route to callers with no token.
 *
 * Needed because Nest composes guards *additively*: a method-level
 * `@UseGuards()` runs in addition to the class-level one, it does not replace
 * it. So the login route — which is what issues the token — cannot exempt
 * itself by re-declaring guards, and neither can the page that shows the login
 * form. This marker is the exemption, and `AdminGuard` reads it.
 *
 * Deliberately its own key rather than reusing `@Public()`. `Public` disengages
 * the global *player* guard and says nothing about this one; if the two shared
 * a key, marking a route public for the player guard would silently open it to
 * the catalogue editor as well.
 */
export const AdminPublic = () => SetMetadata(ADMIN_PUBLIC_KEY, true);

/**
 * Guards every admin route, unless it is marked `@AdminPublic()`.
 *
 * Applied at class level so the default is closed: a route added later is
 * protected by having said nothing, and opening one is an explicit act that
 * shows up in review.
 */
@Injectable()
export class AdminGuard extends AuthGuard(ADMIN_STRATEGY) {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const open = this.reflector.getAllAndOverride<boolean>(ADMIN_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    return open ? true : super.canActivate(context);
  }
}
