import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { JobsModule } from 'src/modules/jobs/jobs.module';
import { HealthController } from './health.controller';
import { QueueHealthIndicator } from './queue.health';
import { RedisHealthIndicator } from './redis.health';

@Module({
  imports: [TerminusModule, JobsModule],
  controllers: [HealthController],
  providers: [RedisHealthIndicator, QueueHealthIndicator],
})
export class HealthModule {}
