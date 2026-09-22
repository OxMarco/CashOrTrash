import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { In, Repository } from 'typeorm';

import { toDto } from 'src/common/serialization/to-dto';
import { nextUtcMidnight } from 'src/common/utils/date.util';
import { BillingConfig } from 'src/config/configuration';
import { User } from '../users/entities/user.entity';
import { BILLING_JOBS, BILLING_QUEUE } from './billing.constants';
import { BillingStateDto, RevenueCatWebhookBody } from './dto/billing.dto';
import { isPremium, quickRoundsToday } from './entitlement';
import { RevenueCatClient } from './revenuecat.client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly config: BillingConfig;

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectQueue(BILLING_QUEUE) private readonly queue: Queue,
    private readonly revenueCat: RevenueCatClient,
    config: ConfigService,
  ) {
    this.config = config.getOrThrow<BillingConfig>('billing');
  }

  async state(
    user: Pick<User, 'id' | 'billingId' | 'premiumExpiresAt'>,
    now: Date = new Date(),
  ): Promise<BillingStateDto> {
    const premium = isPremium(user, now);
    const limit = this.config.freeQuickRoundsPerDay;
    const limited = !premium && limit > 0;
    const used = limited
      ? await quickRoundsToday(this.users.manager, user.id, now)
      : 0;

    return toDto(BillingStateDto, {
      billingId: user.billingId,
      premium,
      premiumExpiresAt: premium ? user.premiumExpiresAt : null,
      freeQuickRoundsPerDay: limited ? limit : null,
      freeQuickRoundsRemaining: limited ? Math.max(0, limit - used) : null,
      freeQuickRoundsResetAt: nextUtcMidnight(now),
    });
  }

  /**
   * Re-reads the player from RevenueCat and stores what it says. Called by the
   * app straight after a purchase or restore, so the unlock does not wait on
   * the webhook, and by the webhook for everything after that.
   */
  async sync(userId: number): Promise<BillingStateDto> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('Player not found');

    user.premiumExpiresAt = await this.revenueCat.entitlementExpiry(
      user.billingId,
    );
    await this.users.update(
      { id: user.id },
      { premiumExpiresAt: user.premiumExpiresAt },
    );
    return this.state(user);
  }

  /**
   * Every id on the event that could be one of ours, re-read in turn. A
   * transfer names both sides, and both have changed. Ids that are not a
   * `billingId` — RevenueCat's own anonymous ones, or a player deleted since —
   * are skipped: there is no one here to update.
   */
  async handleWebhook(body: RevenueCatWebhookBody): Promise<number> {
    const event = body.event;
    if (!event || event.type === 'TEST') return 0;

    const ids = [
      event.app_user_id,
      event.original_app_user_id,
      ...(event.aliases ?? []),
      ...(event.transferred_from ?? []),
      ...(event.transferred_to ?? []),
    ].filter((id): id is string => typeof id === 'string' && UUID.test(id));
    if (ids.length === 0) return 0;

    const players = await this.users.find({
      select: { id: true },
      where: { billingId: In([...new Set(ids)]) },
    });
    for (const player of players) await this.sync(player.id);
    return players.length;
  }

  /**
   * Queued, never awaited against RevenueCat — see `BILLING_JOBS`. The job id
   * is the billing id, so a deletion retried by the client queues once.
   */
  async scheduleCustomerDeletion(billingId: string): Promise<void> {
    await this.queue.add(
      BILLING_JOBS.CUSTOMER_DELETE,
      { billingId },
      { jobId: `${BILLING_JOBS.CUSTOMER_DELETE}-${billingId}` },
    );
  }

  async deleteCustomer(billingId: string): Promise<void> {
    if (!this.revenueCat.configured) {
      this.logger.warn('Billing is not configured; no customer to delete');
      return;
    }
    await this.revenueCat.deleteCustomer(billingId);
  }
}
