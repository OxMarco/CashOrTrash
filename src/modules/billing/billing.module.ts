import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../users/entities/user.entity';
import { BILLING_QUEUE } from './billing.constants';
import {
  BillingController,
  RevenueCatWebhookController,
} from './billing.controller';
import { BillingProcessor } from './billing.processor';
import { BillingService } from './billing.service';
import { RevenueCatClient } from './revenuecat.client';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    BullModule.registerQueue({
      name: BILLING_QUEUE,
      defaultJobOptions: {
        // A deletion owed to a player is worth outlasting a RevenueCat outage
        // for: eight attempts from one minute doubling runs to about four hours.
        attempts: 8,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: 200,
        removeOnFail: 500,
      },
    }),
  ],
  controllers: [BillingController, RevenueCatWebhookController],
  providers: [BillingService, BillingProcessor, RevenueCatClient],
  exports: [BillingService],
})
export class BillingModule {}
