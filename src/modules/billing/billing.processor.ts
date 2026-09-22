import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { BILLING_JOBS, BILLING_QUEUE } from './billing.constants';
import { BillingService } from './billing.service';

@Processor(BILLING_QUEUE)
export class BillingProcessor extends WorkerHost {
  private readonly logger = new Logger(BillingProcessor.name);

  constructor(private readonly billing: BillingService) {
    super();
  }

  async process(job: Job<{ billingId: string }>): Promise<unknown> {
    switch (job.name) {
      case BILLING_JOBS.CUSTOMER_DELETE:
        await this.billing.deleteCustomer(job.data.billingId);
        return { deleted: true };

      default:
        this.logger.warn(`Unknown job: ${job.name}`);
        return null;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.error(
      `${job?.name ?? 'billing job'} failed (attempt ${job?.attemptsMade ?? '?'}): ${error.message}`,
    );
  }
}
