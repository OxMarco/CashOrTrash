import { Module } from '@nestjs/common';

import { CurrencyController } from './currency.controller';
import { CurrencyService } from './currency.service';
import { ExchangeRatesService } from './exchange-rates.service';

@Module({
  controllers: [CurrencyController],
  providers: [CurrencyService, ExchangeRatesService],
  exports: [CurrencyService],
})
export class CurrencyModule {}
