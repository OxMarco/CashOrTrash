import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BillingConfig } from 'src/config/configuration';
import { NEVER_EXPIRES } from './entitlement';

type EntitlementPayload = {
  expires_date: string | null;
  grace_period_expires_date?: string | null;
};

type SubscriberPayload = {
  subscriber?: { entitlements?: Record<string, EntitlementPayload> };
};

/**
 * RevenueCat's REST API, v1, with the secret key.
 *
 * Deliberately two calls wide. Everything the server believes about a
 * purchase comes from `entitlementExpiry` — the webhook only says *who* to
 * re-read — so events arriving late, twice or out of order cannot leave the
 * stored state behind RevenueCat's.
 */
@Injectable()
export class RevenueCatClient {
  private readonly config: BillingConfig;

  constructor(config: ConfigService) {
    this.config = config.getOrThrow<BillingConfig>('billing');
  }

  get configured(): boolean {
    return this.config.revenueCatSecretKey !== '';
  }

  /**
   * When the entitlement runs out for this customer: null if they do not have
   * it, `NEVER_EXPIRES` if it has no end. A billing grace period counts as
   * still paid — the store is retrying the card, and the player has done
   * nothing to lose access over.
   *
   * RevenueCat creates the customer if it does not exist yet, which is fine:
   * one that never buys anything simply stays empty.
   */
  async entitlementExpiry(appUserId: string): Promise<Date | null> {
    const response = await this.request('GET', appUserId);
    const body = (await response.json()) as SubscriberPayload;
    const entitlement =
      body.subscriber?.entitlements?.[this.config.entitlementId];
    if (!entitlement) return null;
    if (entitlement.expires_date === null) return NEVER_EXPIRES;

    const ends = [
      entitlement.expires_date,
      entitlement.grace_period_expires_date,
    ]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => new Date(value).getTime())
      .filter((time) => Number.isFinite(time));
    return ends.length ? new Date(Math.max(...ends)) : null;
  }

  /** Erases the customer and their purchase history. A 404 is already done. */
  async deleteCustomer(appUserId: string): Promise<void> {
    await this.request('DELETE', appUserId, { allowNotFound: true });
  }

  private async request(
    method: 'GET' | 'DELETE',
    appUserId: string,
    { allowNotFound = false } = {},
  ): Promise<Response> {
    if (!this.configured) {
      throw new ServiceUnavailableException('Billing is not configured');
    }

    const response = await fetch(
      `${this.config.revenueCatApiUrl}/subscribers/${encodeURIComponent(appUserId)}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.config.revenueCatSecretKey}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.config.revenueCatTimeoutMs),
      },
    );
    if (response.ok || (allowNotFound && response.status === 404)) {
      return response;
    }
    // The body is not logged: a RevenueCat error can echo the customer back.
    throw new Error(
      `RevenueCat ${method} subscriber failed: ${response.status}`,
    );
  }
}
