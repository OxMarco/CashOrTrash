import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { TypeOrmModule } from '@nestjs/typeorm';

import { JobsModule } from 'src/modules/jobs/jobs.module';
import { Item } from 'src/modules/catalog/entities/item.entity';
import { Theme } from 'src/modules/catalog/entities/theme.entity';
import { CatalogHealthIndicator } from './catalog.health';
import { HealthController } from './health.controller';
import { QueueHealthIndicator } from './queue.health';
import { RedisHealthIndicator } from './redis.health';

@Module({
  imports: [
    TerminusModule,
    TypeOrmModule.forFeature([Item, Theme]),
    JobsModule,
  ],
  controllers: [HealthController],
  providers: [
    RedisHealthIndicator,
    QueueHealthIndicator,
    CatalogHealthIndicator,
  ],
})
export class HealthModule {}
