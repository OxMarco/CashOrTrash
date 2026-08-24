import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MediaModule } from '../media/media.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { Item } from './entities/item.entity';
import { ItemCopy } from './entities/item-copy.entity';
import { ThemeStat } from './entities/theme-stat.entity';
import { Theme } from './entities/theme.entity';
import { ItemCopyService } from './copy/item-copy.service';
import { ItemCopywriter } from './copy/item-copywriter.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Theme, Item, ItemCopy, ThemeStat]),
    MediaModule,
  ],
  controllers: [CatalogController],
  providers: [CatalogService, ItemCopyService, ItemCopywriter],
  exports: [CatalogService, ItemCopyService, TypeOrmModule],
})
export class CatalogModule {}
