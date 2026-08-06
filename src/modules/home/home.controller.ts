import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { toDto } from 'src/common/serialization/to-dto';
import { todayUtc } from 'src/common/utils/date.util';
import { DailyService } from '../daily/daily.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { SessionStatus } from '../sessions/entities/game-session.entity';
import { SessionsService } from '../sessions/sessions.service';
import { UsersService } from '../users/users.service';
import { HomeResponseDto } from './dto/home.dto';

@ApiTags('home')
@Controller('home')
export class HomeController {
  constructor(
    private readonly users: UsersService,
    private readonly daily: DailyService,
    private readonly sessions: SessionsService,
    private readonly leaderboard: LeaderboardService,
  ) {}

  /**
   * Deliberately one round trip. Home renders a greeting, a points tag, the
   * daily hero card with its countdown and progress dots, and the stats card —
   * four calls would mean four spinners on the first screen after launch.
   */
  @Get()
  @ApiOperation({ summary: 'Everything the Home screen needs, in one call.' })
  async home(@CurrentUser('id') userId: number): Promise<HomeResponseDto> {
    const today = todayUtc();

    const [user, reset, session, globalRank] = await Promise.all([
      this.users.getById(userId),
      Promise.resolve(this.daily.resetInfo()),
      this.sessions.findActiveDaily(userId),
      this.leaderboard.getRank('today', userId),
    ]);

    const challenge = await this.daily.getOrCreate(today);
    const roundCount = challenge.itemIds.length;
    const roundsPlayed = session?.currentIndex ?? 0;
    const isComplete = session?.status === SessionStatus.COMPLETE;

    return toDto(HomeResponseDto, {
      greeting: user.username
        ? `What’s it worth, ${capitalise(user.username)}?`
        : 'What’s it worth?',
      player: {
        username: user.username,
        avatarSeed: user.avatarSeed,
        totalPoints: user.totalPoints,
        streakDays: this.users.effectiveStreak(user, today),
        bestRoundScore: user.bestRoundScore,
        globalRank,
      },
      daily: {
        ...reset,
        sessionId: session?.id ?? null,
        roundsPlayed,
        roundCount,
        isComplete,
        totalScore: session?.totalScore ?? 0,
        ctaLabel: ctaLabel(roundsPlayed, isComplete),
      },
    });
  }
}

const ctaLabel = (roundsPlayed: number, isComplete: boolean): string => {
  if (isComplete) return 'See today’s result';
  if (roundsPlayed === 0) return 'Play today’s five';
  return `Continue · round ${roundsPlayed + 1}`;
};

const capitalise = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);
