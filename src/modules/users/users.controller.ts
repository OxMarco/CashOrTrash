import {
  Body,
  Controller,
  Delete,
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
import { BillingService } from '../billing/billing.service';
import { DEFAULT_LANGUAGE } from '../catalog/language.constants';
import { DEFAULT_CURRENCY } from '../currency/currency.constants';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { RoundQueryDto } from '../sessions/dto/round-query.dto';
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
    private readonly billing: BillingService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Profile and the stats card on Home.',
    description:
      '`?currency` and `?lang` shape `lastDailyMiss` only — the amounts on ' +
      'that card and the item’s title. Dollars and English by default.',
  })
  async me(
    @CurrentUser('id') userId: number,
    @Query() query: RoundQueryDto,
  ): Promise<MeDto> {
    const today = todayUtc();
    const user = await this.users.getById(userId);
    const [globalRank, dailyProgress, lastDailyMiss, billing] =
      await Promise.all([
        this.leaderboard.getRank('today', userId),
        this.users.dailyProgress(userId, today),
        this.users.lastDailyMiss(
          userId,
          today,
          query.currency ?? DEFAULT_CURRENCY,
          query.lang ?? DEFAULT_LANGUAGE,
        ),
        this.billing.state(user),
      ]);

    return toDto(MeDto, {
      ...user,
      streakDays: this.users.effectiveStreak(user, today),
      globalRank,
      dailyProgress,
      lastDailyMiss,
      billing,
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
    const today = todayUtc();
    const user = await this.users.claimUsername(userId, dto.username);
    const [globalRank, dailyProgress, billing] = await Promise.all([
      this.leaderboard.getRank('today', userId),
      this.users.dailyProgress(userId, today),
      this.billing.state(user),
    ]);

    return toDto(MeDto, {
      ...user,
      streakDays: this.users.effectiveStreak(user, today),
      globalRank,
      dailyProgress,
      billing,
      // The card this feeds is Home's, and Home re-reads `/me` after a claim.
      lastDailyMiss: null,
    });
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Permanently delete this player and their gameplay data.',
  })
  async deleteAccount(@CurrentUser('id') userId: number): Promise<void> {
    const { billingId } = await this.users.getById(userId);
    await this.users.deleteAccount(userId);

    // RevenueCat keeps its own record of the player — purchases, receipts —
    // and that is theirs to have erased too. Queued after the commit, so a
    // rollback never costs a live player their purchase history; the job's
    // retries outlast an outage there.
    await this.billing.scheduleCustomerDeletion(billingId);

    // Redis is a serving cache, not part of the deletion transaction. The
    // authoritative data is already gone even if this best-effort cleanup has
    // to wait for cache TTLs after an outage.
    await this.leaderboard.removeUser(userId).catch(() => undefined);
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
