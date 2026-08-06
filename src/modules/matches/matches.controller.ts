import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CreateMatchDto, JoinMatchDto, MatchDto } from './dto/match.dto';
import { MatchesService } from './matches.service';

@ApiTags('matches')
@Controller('matches')
export class MatchesController {
  constructor(private readonly matches: MatchesService) {}

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Open a match and get the invite code and deep link.',
  })
  async create(
    @CurrentUser('id') userId: number,
    @Body() dto: CreateMatchDto,
  ): Promise<MatchDto> {
    return this.matches.create(userId, dto.themeSlug);
  }

  @Post('join')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Join a match from an invite code.' })
  async join(
    @CurrentUser('id') userId: number,
    @Body() dto: JoinMatchDto,
  ): Promise<MatchDto> {
    return this.matches.join(dto.inviteCode, userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Match state, including live presence per player.' })
  async get(
    @CurrentUser('id') userId: number,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MatchDto> {
    return this.matches.getForPlayer(id, userId);
  }
}
