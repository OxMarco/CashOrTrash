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
import { LanguageQueryDto } from '../catalog/dto/language.dto';
import { DEFAULT_LANGUAGE } from '../catalog/language.constants';
import { RoundQueryDto } from './dto/round-query.dto';
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
  // Starting a session is what deals five items, and finishing them reveals
  // five prices — so this, not the bet, is the endpoint a catalogue harvester
  // leans on. Per account, not per address: see `UserThrottlerGuard`.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
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
      'euro grid is not on the dollar one. The title and description come ' +
      'back in `?lang`, English by default and English wherever an item has ' +
      'no copy in the language asked for.',
  })
  async current(
    @CurrentUser('id') userId: number,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: RoundQueryDto,
  ): Promise<CurrentRoundDto> {
    return this.sessions.getCurrentRound(
      id,
      userId,
      query.currency ?? DEFAULT_CURRENCY,
      query.lang ?? DEFAULT_LANGUAGE,
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
    @Query() query: LanguageQueryDto,
  ): Promise<RevealResponseDto> {
    return this.sessions.placeBet(
      id,
      userId,
      index,
      dto,
      query.lang ?? DEFAULT_LANGUAGE,
    );
  }

  @Get(':id/summary')
  @ApiOperation({ summary: 'End-of-game summary, percentile and share text.' })
  async summary(
    @CurrentUser('id') userId: number,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: RoundQueryDto,
  ): Promise<SessionSummaryDto> {
    return this.sessions.getSummary(
      id,
      userId,
      query.currency ?? DEFAULT_CURRENCY,
      query.lang ?? DEFAULT_LANGUAGE,
    );
  }
}
