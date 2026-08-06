import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MediaModule } from '../media/media.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { Item } from './entities/item.entity';
import { ThemeStat } from './entities/theme-stat.entity';
import { Theme } from './entities/theme.entity';
import { CatalogImportService } from './import/catalog-import.service';
import { ItemCopywriter } from './import/item-copywriter.service';

@Module({
  imports: [TypeOrmModule.forFeature([Theme, Item, ThemeStat]), MediaModule],
  controllers: [CatalogController],
  providers: [CatalogService, CatalogImportService, ItemCopywriter],
  exports: [CatalogService, CatalogImportService, TypeOrmModule],
})
export class CatalogModule {}
