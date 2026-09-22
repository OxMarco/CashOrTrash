import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';

import { User } from '../users/entities/user.entity';
import { BillingService } from './billing.service';
import { RevenueCatClient } from './revenuecat.client';

const OURS = '6f1c1e7a-3b9d-4b8a-9d2e-1f0a2b3c4d5e';
const THEIRS = '0b7e5a4c-2d1f-4e3a-8b9c-7d6e5f4a3b2c';

const build = () => {
  const users = {
    find: jest.fn().mockResolvedValue([{ id: 7 }]),
    findOne: jest
      .fn()
      .mockResolvedValue({ id: 7, billingId: OURS, premiumExpiresAt: null }),
    update: jest.fn().mockResolvedValue(undefined),
    manager: { getRepository: () => ({ count: () => Promise.resolve(0) }) },
  };
  const revenueCat = {
    configured: true,
    entitlementExpiry: jest.fn().mockResolvedValue(new Date('2099-01-01Z')),
    deleteCustomer: jest.fn(),
  };
  const queue = { add: jest.fn() };
  const service = new BillingService(
    users as unknown as Repository<User>,
    queue as unknown as Queue,
    revenueCat as unknown as RevenueCatClient,
    {
      getOrThrow: () => ({ freeQuickRoundsPerDay: 5 }),
    } as unknown as ConfigService,
  );
  return { service, users, revenueCat, queue };
};

describe('BillingService', () => {
  it('re-reads every id on the event that could be a player', async () => {
    const { service, users } = build();

    await service.handleWebhook({
      event: {
        type: 'TRANSFER',
        app_user_id: OURS,
        aliases: [OURS, '$RCAnonymousID:abc'],
        transferred_from: [THEIRS],
      },
    });

    // RevenueCat's own anonymous ids can never be a `billingId`; asking the
    // database about them would only be noise.
    const where = users.find.mock.calls[0][0].where;
    expect(where.billingId.value).toEqual([OURS, THEIRS]);
  });

  it('stores what RevenueCat says, not what the event says', async () => {
    const { service, users, revenueCat } = build();

    await service.handleWebhook({
      event: { type: 'CANCELLATION', app_user_id: OURS },
    });

    expect(revenueCat.entitlementExpiry).toHaveBeenCalledWith(OURS);
    expect(users.update).toHaveBeenCalledWith(
      { id: 7 },
      { premiumExpiresAt: new Date('2099-01-01Z') },
    );
  });

  it('ignores the dashboard test event and events for no one here', async () => {
    const { service, users } = build();

    await expect(
      service.handleWebhook({ event: { type: 'TEST', app_user_id: OURS } }),
    ).resolves.toBe(0);
    await expect(
      service.handleWebhook({
        event: { type: 'RENEWAL', app_user_id: '$RCAnonymousID:x' },
      }),
    ).resolves.toBe(0);
    expect(users.find).not.toHaveBeenCalled();
  });

  it('reports premium without counting rounds, and free with the allowance', async () => {
    const { service } = build();
    const now = new Date('2026-09-22T12:00:00Z');

    await expect(
      service.state(
        { id: 7, billingId: OURS, premiumExpiresAt: new Date('2026-10-01Z') },
        now,
      ),
    ).resolves.toMatchObject({
      premium: true,
      freeQuickRoundsPerDay: null,
      freeQuickRoundsRemaining: null,
    });
    await expect(
      service.state(
        { id: 7, billingId: OURS, premiumExpiresAt: new Date('2026-09-01Z') },
        now,
      ),
    ).resolves.toMatchObject({
      premium: false,
      premiumExpiresAt: null,
      freeQuickRoundsPerDay: 5,
      freeQuickRoundsRemaining: 5,
      freeQuickRoundsResetAt: new Date('2026-09-23T00:00:00Z'),
    });
  });

  it('queues a deleted player’s customer for erasure once', async () => {
    const { service, queue } = build();

    await service.scheduleCustomerDeletion(OURS);

    expect(queue.add).toHaveBeenCalledWith(
      'customer-delete',
      { billingId: OURS },
      { jobId: `customer-delete-${OURS}` },
    );
  });
});
