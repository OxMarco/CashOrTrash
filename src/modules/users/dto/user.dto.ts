import { ApiProperty } from '@nestjs/swagger';

import {
  Currency,
  SUPPORTED_CURRENCIES,
} from '../../currency/currency.constants';
import { Expose, Type } from 'class-transformer';
import { IsString, Length } from 'class-validator';

export class ClaimUsernameDto {
  @ApiProperty({ example: 'sam' })
  @IsString()
  @Length(1, 64)
  username: string;
}

export class UsernameAvailabilityDto {
  @Expose()
  available: boolean;

  @ApiProperty({ description: 'The handle as it would be stored.' })
  @Expose()
  normalised: string;

  @ApiProperty({
    nullable: true,
    description: 'Player-facing copy for the inline hint; null when available.',
  })
  @Expose()
  reason: string | null;

  @ApiProperty({
    nullable: true,
    enum: ['username-invalid', 'username-not-allowed', 'username-taken'],
    description:
      'Stable slug for the client to pick its own copy from; null when available.',
  })
  @Expose()
  code: string | null;
}

/** `GET /v1/me` — profile plus the stats Home renders. */
/**
 * How far into today's challenge the player is.
 *
 * The device used to keep this itself, recording each bet as it was placed so
 * Home's progress dots could answer before any request did. That record was the
 * last thing the app scored a game from, and it disagreed with the server the
 * moment a round was played on another device. Progress is a fact about the
 * session, and the session lives here.
 */
/**
 * The round of the last finished daily the player was furthest off on, for
 * Home's "yesterday's find that got you" card. Amounts are in the `currency`
 * the request asked for.
 */
export class LastDailyMissDto {
  @ApiProperty({ description: 'The UTC challenge day the round belongs to.' })
  @Expose()
  challengeDate: string;

  @Expose()
  itemId: number;

  @Expose()
  title: string;

  @Expose()
  photoUrl: string;

  @ApiProperty({ enum: SUPPORTED_CURRENCIES })
  @Expose()
  currency: Currency;

  @ApiProperty({ description: 'The bet’s low edge, minor units.' })
  @Expose()
  loCents: number;

  @ApiProperty({ description: 'The bet’s high edge, minor units.' })
  @Expose()
  hiCents: number;

  @ApiProperty({ description: 'What it actually went for, minor units.' })
  @Expose()
  truePriceCents: number;
}

export class DailyProgressDto {
  @ApiProperty({ description: 'The UTC challenge day this describes.' })
  @Expose()
  challengeDate: string;

  @ApiProperty({ description: 'Rounds already bet on today, 0 if none.' })
  @Expose()
  roundsPlayed: number;

  @Expose()
  roundCount: number;

  @ApiProperty({ description: 'True once every round has been played.' })
  @Expose()
  complete: boolean;
}

export class MeDto {
  @Expose()
  id: number;

  @ApiProperty({ nullable: true })
  @Expose()
  username: string | null;

  @Expose()
  avatarSeed: string;

  @Expose()
  totalPoints: number;

  @ApiProperty({
    description: 'Zero once the streak lapses, whatever is stored.',
  })
  @Expose()
  streakDays: number;

  @Expose()
  bestRoundScore: number;

  @ApiProperty({
    nullable: true,
    description: 'Today’s global rank, if ranked.',
  })
  @Expose()
  globalRank: number | null;

  @Expose()
  createdAt: Date;

  @ApiProperty({
    type: () => DailyProgressDto,
    description:
      'Progress through today’s challenge. Present even before it is started, ' +
      'so a client can render "Play" and "Continue · round 3" from one answer.',
  })
  @Expose()
  @Type(() => DailyProgressDto)
  dailyProgress: DailyProgressDto;

  @ApiProperty({
    type: () => LastDailyMissDto,
    nullable: true,
    description:
      'The round of the last finished daily before today that the player ' +
      'was furthest off on, relative to the price. Null with no finished ' +
      'daily behind them, or one they hit every round of.',
  })
  @Expose()
  @Type(() => LastDailyMissDto)
  lastDailyMiss: LastDailyMissDto | null;
}
