import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsString, Length } from 'class-validator';

import { MatchStatus } from '../entities/match.entity';

export class CreateMatchDto {
  @ApiProperty({ example: 'vintage-finds' })
  @IsString()
  @Length(1, 64)
  themeSlug: string;
}

export class JoinMatchDto {
  @ApiProperty({ example: 'K7PXQ2' })
  @IsString()
  @Length(4, 12)
  inviteCode: string;
}

export class MatchPlayerDto {
  @ApiProperty({ nullable: true })
  @Expose()
  userId: number | null;

  @ApiProperty({ nullable: true })
  @Expose()
  username: string | null;

  @ApiProperty({ nullable: true })
  @Expose()
  avatarSeed: string | null;

  @ApiProperty({
    description: 'Rounds won, not points — the match is best of 5.',
  })
  @Expose()
  score: number;

  @ApiProperty({ description: 'Rounds this player has already bet on.' })
  @Expose()
  roundsPlayed: number;

  @ApiProperty({ description: 'Connected to the match socket right now.' })
  @Expose()
  online: boolean;
}

export class MatchDto {
  @ApiProperty()
  @Expose()
  id: string;

  @ApiProperty()
  @Expose()
  inviteCode: string;

  @ApiProperty({ example: 'cashortrash://match/K7PXQ2' })
  @Expose()
  deepLink: string;

  @ApiProperty({ enum: MatchStatus })
  @Expose()
  status: MatchStatus;

  @ApiProperty()
  @Expose()
  themeSlug: string;

  @ApiProperty()
  @Expose()
  roundCount: number;

  @ApiProperty({ type: MatchPlayerDto })
  @Expose()
  host: MatchPlayerDto;

  @ApiProperty({ type: MatchPlayerDto, nullable: true })
  @Expose()
  guest: MatchPlayerDto | null;

  @ApiProperty({
    nullable: true,
    description: 'Null while in progress or on a draw.',
  })
  @Expose()
  winnerUserId: number | null;
}
