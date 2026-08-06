import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { DEFAULT_CURRENCY } from '../currency/currency.constants';
import { CurrencyQueryDto } from '../currency/dto/currency.dto';
import {
  CreateSessionDto,
  CurrentRoundDto,
  PlaceBetDto,
  RevealResponseDto,
  SessionDto,
  SessionSummaryDto,
} from './dto/session.dto';
import { SessionsService } from './sessions.service';

@ApiTags('sessions')
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Post()
  @ApiOperation({
    summary:
      'Create a session, or resume the in-progress one. Daily is idempotent.',
  })
  async create(
    @CurrentUser('id') userId: number,
    @Body() dto: CreateSessionDto,
  ): Promise<SessionDto> {
    return this.sessions.createOrResume(userId, dto);
  }

  @Get(':id/current')
  @ApiOperation({
    summary: 'The item to price, with slider bounds — never the true price.',
    description:
      'Amounts come back in `?currency`, dollars by default. Bet in the same ' +
      'one: the slider grid differs per currency, and a bet snapped to the ' +
      'euro grid is not on the dollar one.',
  })
  async current(
    @CurrentUser('id') userId: number,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CurrencyQueryDto,
  ): Promise<CurrentRoundDto> {
    return this.sessions.getCurrentRound(
      id,
      userId,
      query.currency ?? DEFAULT_CURRENCY,
    );
  }

  /**
   * The only endpoint in the API that returns `truePriceCents`, and it does so
   * only after the bet is durably recorded.
   */
  @Post(':id/rounds/:index/bet')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Place the range bet and reveal the price.' })
  async bet(
    @CurrentUser('id') userId: number,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() dto: PlaceBetDto,
  ): Promise<RevealResponseDto> {
    return this.sessions.placeBet(id, userId, index, dto);
  }

  @Get(':id/summary')
  @ApiOperation({ summary: 'End-of-game summary, percentile and share text.' })
  async summary(
    @CurrentUser('id') userId: number,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CurrencyQueryDto,
  ): Promise<SessionSummaryDto> {
    return this.sessions.getSummary(
      id,
      userId,
      query.currency ?? DEFAULT_CURRENCY,
    );
  }
}
