import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';

import {
  Currency,
  DEFAULT_CURRENCY,
  SUPPORTED_CURRENCIES,
} from '../currency.constants';

export class CurrencyDto {
  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'EUR' })
  @Expose()
  code: Currency;

  @ApiProperty({ example: '€' })
  @Expose()
  symbol: string;

  @ApiProperty({
    example: 0.92,
    description: 'Units of this currency to one US dollar. Always 1 for USD.',
  })
  @Expose()
  rate: number;

  @ApiProperty({
    example: '2026-08-03T00:00:00.000Z',
    description:
      'When the provider published this rate. The epoch means no live fetch ' +
      'has landed yet and the configured fallback is standing in.',
  })
  @Expose()
  asOf: string;
}

/**
 * The currency a money-bearing response should speak, as a query parameter.
 *
 * A class rather than a bare `@Query('currency')` because the global pipe runs
 * `forbidNonWhitelisted`: an unknown or misspelled currency is refused at the
 * edge, so no endpoint has to decide what to do with `?currency=BTC`.
 */
export class CurrencyQueryDto {
  @ApiPropertyOptional({
    enum: SUPPORTED_CURRENCIES,
    default: DEFAULT_CURRENCY,
    description: 'Omitted means US dollars — the unit prices are stored in.',
  })
  @IsOptional()
  @IsIn(SUPPORTED_CURRENCIES)
  currency?: Currency;
}
