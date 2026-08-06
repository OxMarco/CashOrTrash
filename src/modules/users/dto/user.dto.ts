import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsString, Length } from 'class-validator';

export class ClaimUsernameDto {
  @ApiProperty({ example: 'sam' })
  @IsString()
  @Length(1, 64)
  username: string;
}

export class UsernameAvailabilityDto {
  @ApiProperty()
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
export class MeDto {
  @ApiProperty()
  @Expose()
  id: number;

  @ApiProperty({ nullable: true })
  @Expose()
  username: string | null;

  @ApiProperty()
  @Expose()
  avatarSeed: string;

  @ApiProperty()
  @Expose()
  totalPoints: number;

  @ApiProperty({
    description: 'Zero once the streak lapses, whatever is stored.',
  })
  @Expose()
  streakDays: number;

  @ApiProperty()
  @Expose()
  bestRoundScore: number;

  @ApiProperty({
    nullable: true,
    description: 'Today’s global rank, if ranked.',
  })
  @Expose()
  globalRank: number | null;

  @ApiProperty()
  @Expose()
  createdAt: Date;
}
