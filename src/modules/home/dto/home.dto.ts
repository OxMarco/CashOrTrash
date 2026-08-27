import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

export class HomePlayerDto {
  @ApiProperty({ nullable: true })
  @Expose()
  username: string | null;

  @Expose()
  avatarSeed: string;

  @ApiProperty({ description: 'The "1,240 pts" tag.' })
  @Expose()
  totalPoints: number;

  @ApiProperty({ description: 'Your streak. Zero once it lapses.' })
  @Expose()
  streakDays: number;

  @Expose()
  bestRoundScore: number;

  @ApiProperty({
    nullable: true,
    description: 'Global rank, or null if unranked.',
  })
  @Expose()
  globalRank: number | null;
}

export class HomeDailyDto {
  @Expose()
  challengeDate: string;

  @ApiProperty({ description: 'The instant the challenge rolls over, UTC.' })
  @Expose()
  resetsAt: Date;

  @ApiProperty({
    description: 'Drives "resets in 6h 12m" without a client clock.',
  })
  @Expose()
  secondsUntilReset: number;

  @ApiProperty({ nullable: true, description: 'Null until the player starts.' })
  @Expose()
  sessionId: string | null;

  @ApiProperty({
    description: 'Rounds already played today — the progress dots.',
  })
  @Expose()
  roundsPlayed: number;

  @Expose()
  roundCount: number;

  @Expose()
  isComplete: boolean;

  @ApiProperty({ description: 'Score so far today.' })
  @Expose()
  totalScore: number;

  @ApiProperty({
    example: 'Continue · round 3',
    description: 'Contextual label for the hero button.',
  })
  @Expose()
  ctaLabel: string;
}

/** One call fills the entire Home screen. */
export class HomeResponseDto {
  @ApiProperty({ example: 'What’s it worth, Sam?' })
  @Expose()
  greeting: string;

  @ApiProperty({ type: HomePlayerDto })
  @Expose()
  @Type(() => HomePlayerDto)
  player: HomePlayerDto;

  @ApiProperty({ type: HomeDailyDto })
  @Expose()
  @Type(() => HomeDailyDto)
  daily: HomeDailyDto;
}
