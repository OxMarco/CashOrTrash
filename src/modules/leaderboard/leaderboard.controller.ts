import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import {
  LeaderboardQueryDto,
  LeaderboardResponseDto,
} from './dto/leaderboard.dto';
import { LeaderboardService } from './leaderboard.service';

@ApiTags('leaderboard')
@Controller('leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Get()
  @ApiOperation({
    summary: 'Podium, ranked rows, the player’s row and their neighbours.',
  })
  async board(
    @CurrentUser('id') userId: number,
    @Query() query: LeaderboardQueryDto,
  ): Promise<LeaderboardResponseDto> {
    return this.leaderboard.getBoard(query.scope, userId);
  }
}
