import { Module } from '@nestjs/common';

import { PricingService } from './pricing.service';
import { ScoringService } from './scoring.service';

@Module({
  providers: [ScoringService, PricingService],
  exports: [ScoringService, PricingService],
})
export class ScoringModule {}
