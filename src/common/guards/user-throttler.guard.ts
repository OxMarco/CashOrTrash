import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

import { AuthenticatedUser } from '../decorators/current-user.decorator';

/**
 * Rate limits by account where there is one, and by address where there is not.
 *
 * The stock guard keys everything on `req.ip`, which is the wrong unit for a
 * game. It punishes the innocent — a school, an office, a mobile carrier's NAT
 * all share one address, and one keen player there spends everybody's budget —
 * and it does nothing to the guilty, because the whole point of a farm is that
 * it has more addresses than the operator has patience. Every limit in the API
 * was measuring the network rather than the player.
 *
 * Keying on the authenticated user fixes both ends: a budget follows the
 * account that spends it, and buying more of one now means minting more
 * accounts — which is itself budgeted, per address, in `AuthService`.
 *
 * Only `getTracker` is overridden. The base class builds its key as
 * `sha256(class-handler-throttlerName-tracker)`, so every existing per-route
 * `@Throttle` keeps its own bucket and simply starts counting per account.
 *
 * Unauthenticated routes fall back to the address, which is correct rather than
 * a compromise: `POST /auth/anonymous` has no account to charge yet, and it is
 * exactly the route where the address is the thing worth limiting.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  /**
   * Registered after `JwtAuthGuard` in AppModule's providers, which is what
   * puts `req.user` here to be read: Nest runs global guards in provider order
   * and awaits each, and passport assigns onto the same request object the
   * throttler reads.
   *
   * If that ordering is ever disturbed this silently degrades to the old
   * IP-keyed behaviour — nothing breaks, the fix just stops working, which is
   * the worst way for a control to fail. `test/integrity/rate-limit.e2e-spec`
   * is what makes it loud: two accounts on one address must not share a budget.
   * A runtime assertion here would instead 500 every anonymous request.
   */
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as AuthenticatedUser | undefined;
    const tracker = user?.id
      ? `user:${user.id}`
      : `ip:${typeof req.ip === 'string' ? req.ip : 'unknown'}`;

    // The base class awaits this, and there is nothing here to await.
    return Promise.resolve(tracker);
  }
}
