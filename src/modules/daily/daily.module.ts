import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CatalogModule } from '../catalog/catalog.module';
import { DailyService } from './daily.service';
import { DailyChallenge } from './entities/daily-challenge.entity';

@Module({
  imports: [TypeOrmModule.forFeature([DailyChallenge]), CatalogModule],
  providers: [DailyService],
  exports: [DailyService],
})
export class DailyModule {}
