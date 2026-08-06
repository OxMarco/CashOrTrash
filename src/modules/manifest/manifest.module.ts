import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { CurrencyModule } from '../currency/currency.module';
import { ManifestController } from './manifest.controller';

/**
 * Owns no state of its own — it reads the same services the resources it
 * versions are served from, so a version cannot describe a payload the client
 * would not actually receive.
 */
@Module({
  imports: [CatalogModule, CurrencyModule],
  controllers: [ManifestController],
})
export class ManifestModule {}
