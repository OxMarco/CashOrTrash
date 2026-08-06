import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, Length } from 'class-validator';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Public } from 'src/common/decorators/public.decorator';
import { toDto } from 'src/common/serialization/to-dto';
import { todayUtc } from 'src/common/utils/date.util';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import {
  ClaimUsernameDto,
  MeDto,
  UsernameAvailabilityDto,
} from './dto/user.dto';
import { UsernameService, USERNAME_TAKEN } from './username.service';
import { UsersService } from './users.service';

class AvailabilityQueryDto {
  /** Named `u` to keep the onboarding screen's per-keystroke probe short. */
  @IsString()
  @Length(1, 64)
  u: string;
}

@ApiTags('users')
@Controller('me')
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly leaderboard: LeaderboardService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Profile and the stats card on Home.' })
  async me(@CurrentUser('id') userId: number): Promise<MeDto> {
    const user = await this.users.getById(userId);
    const globalRank = await this.leaderboard.getRank('today', userId);

    return toDto(MeDto, {
      ...user,
      streakDays: this.users.effectiveStreak(user, todayUtc()),
      globalRank,
    });
  }

  @Post('username')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Claim or change the player handle.' })
  async claimUsername(
    @CurrentUser('id') userId: number,
    @Body() dto: ClaimUsernameDto,
  ): Promise<MeDto> {
    const user = await this.users.claimUsername(userId, dto.username);
    const globalRank = await this.leaderboard.getRank('today', userId);

    return toDto(MeDto, {
      ...user,
      streakDays: this.users.effectiveStreak(user, todayUtc()),
      globalRank,
    });
  }
}

@ApiTags('users')
@Controller('usernames')
export class UsernamesController {
  constructor(
    private readonly users: UsersService,
    private readonly usernames: UsernameService,
  ) {}

  /**
   * Public because it runs during onboarding, before a token exists — and
   * throttled hard for exactly the same reason: an unauthenticated endpoint
   * that answers "does this handle exist" is an enumeration primitive.
   */
  @Public()
  @Get('availability')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Live availability check for the onboarding field.',
  })
  async availability(
    @Query() query: AvailabilityQueryDto,
  ): Promise<UsernameAvailabilityDto> {
    const check = this.usernames.check(query.u);
    if (!check.ok) {
      return toDto(UsernameAvailabilityDto, {
        available: false,
        normalised: check.normalised,
        reason: this.usernames.describe(check.reason!),
        code: this.usernames.problemCode(check.reason!),
      });
    }

    const available = await this.users.isUsernameAvailable(check.normalised);

    return toDto(UsernameAvailabilityDto, {
      available,
      normalised: check.normalised,
      reason: available ? null : 'That name is already taken',
      code: available ? null : USERNAME_TAKEN,
    });
  }
}
