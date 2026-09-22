import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import Redis from 'ioredis';

import { AdminConfig } from 'src/config/configuration';
import { REDIS_CLIENT } from 'src/redis/redis.constants';
import { verifyAdminPassword } from './admin-password';

/**
 * How many wrong passwords an address may offer, and over what window.
 *
 * There is one credential and no account to lock out, so a lockout would be a
 * denial-of-service against the only operator. A per-address budget slows a
 * guesser without ever locking the door: the operator's own address is not the
 * one spending the budget.
 */
const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 15 * 60;

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);
  private readonly config: AdminConfig;

  constructor(
    private readonly jwt: JwtService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.config = config.getOrThrow<AdminConfig>('admin');
  }

  /** Whether the portal is configured at all. */
  get enabled(): boolean {
    return Boolean(this.config.passwordHash && this.config.jwtSecret);
  }

  /**
   * Trades the password for a bearer token.
   *
   * The failure paths are deliberately indistinguishable to a caller: a wrong
   * password and an exhausted budget both answer 401 after the same work, so
   * the response cannot be used to map how far a guessing run has got. Only an
   * unconfigured portal answers differently, because that is a deployment fault
   * the operator needs told plainly rather than a secret worth keeping.
   */
  async login(password: string, address: string | null): Promise<string> {
    if (!this.enabled) {
      throw new ServiceUnavailableException(
        'The admin portal is not configured on this deployment.',
      );
    }

    // Reserved before the password is checked, not recorded after. Checking
    // the count and charging it later left the whole scrypt verification in
    // between: a burst of concurrent guesses all read the same count under
    // the limit and were all verified, so the budget capped nothing against
    // exactly the parallel run it exists to slow down.
    const within = await this.reserveAttempt(address);
    const correct = await verifyAdminPassword(
      password,
      this.config.passwordHash,
    );

    if (!within || !correct) {
      this.logger.warn(
        `Rejected an admin login from ${address ?? 'an unknown address'}` +
          (within ? '' : ' (attempt budget exhausted)'),
      );
      throw new UnauthorizedException('Incorrect password');
    }

    await this.clearFailures(address);
    return this.jwt.signAsync(
      { typ: 'admin' },
      {
        secret: this.config.jwtSecret,
        // Same cast AuthService makes: the config carries a duration string and
        // jsonwebtoken's types want its own literal union.
        expiresIn: this.config.sessionTtl as JwtSignOptions['expiresIn'],
      },
    );
  }

  private key(address: string | null): string | null {
    return address ? `admin:login:${address}` : null;
  }

  /**
   * Charges one attempt to the address and says whether it was within budget.
   *
   * Every attempt is charged, right or wrong; a successful login then clears
   * the counter, so only failures are left counting against the address. The
   * increment and the expiry go in one `MULTI`, so there is no moment where
   * the counter exists without a window — a crash between the two used to be
   * able to leave a budget that never reset. `EXPIRE … NX` sets the window only
   * on a key that has none, so a run of attempts cannot keep pushing it out and
   * make the budget permanent, and a key left without a TTL by that older code
   * gets one on its next attempt.
   */
  private async reserveAttempt(address: string | null): Promise<boolean> {
    const key = this.key(address);
    // No address to budget against — the proxy did not pass one. Falling open
    // is correct: the alternative refuses every login on a misconfigured proxy
    // and locks the operator out of their own portal.
    if (!key) return true;

    const results = await this.redis
      .multi()
      .incr(key)
      .expire(key, WINDOW_SECONDS, 'NX')
      .exec();
    const [error, used] = results?.[0] ?? [new Error('transaction aborted')];
    if (error) throw error;
    return Number(used) <= MAX_ATTEMPTS;
  }

  private async clearFailures(address: string | null): Promise<void> {
    const key = this.key(address);
    if (key) await this.redis.del(key);
  }
}
