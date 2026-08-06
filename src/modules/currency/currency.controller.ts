import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { toDtoArray } from 'src/common/serialization/to-dto';
import { CurrencyService } from './currency.service';
import { CurrencyDto } from './dto/currency.dto';

@ApiTags('currency')
@Controller('currencies')
export class CurrencyController {
  constructor(private readonly currency: CurrencyService) {}

  @Get()
  @ApiOperation({
    summary:
      'The currencies a round may be played in, and what a dollar buys of each.',
  })
  currencies(): CurrencyDto[] {
    return toDtoArray(CurrencyDto, this.currency.list());
  }
}
