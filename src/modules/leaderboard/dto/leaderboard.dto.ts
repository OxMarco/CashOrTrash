import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { IsEnum, IsOptional } from 'class-validator';

export enum LeaderboardScopeParam {
  TODAY = 'today',
  WEEK = 'week',
  FRIENDS = 'friends',
}

export class LeaderboardQueryDto {
  @ApiPropertyOptional({ enum: LeaderboardScopeParam, default: 'today' })
  @IsOptional()
  @IsEnum(LeaderboardScopeParam)
  scope: LeaderboardScopeParam = LeaderboardScopeParam.TODAY;
}

export class LeaderboardRowDto {
  @Expose()
  rank: number;

  @Expose()
  userId: number;

  @ApiProperty({ nullable: true })
  @Expose()
  username: string | null;

  @Expose()
  avatarSeed: string;

  @Expose()
  score: number;

  @ApiProperty({ description: 'True for the requesting player’s own row.' })
  @Expose()
  isMe: boolean;
}

export class LeaderboardMeDto {
  @ApiProperty({
    nullable: true,
    description: 'Null when the player has no score yet.',
  })
  @Expose()
  rank: number | null;

  @Expose()
  score: number;

  @ApiProperty({
    nullable: true,
    description:
      'Yesterday’s final rank minus today’s live rank; the "▲ 41" tag.',
  })
  @Expose()
  delta: number | null;

  @ApiProperty({
    nullable: true,
    description: 'Percent of players beaten, 0–100. Null when unranked.',
  })
  @Expose()
  percentile: number | null;
}

export class LeaderboardResponseDto {
  @ApiProperty({ enum: LeaderboardScopeParam })
  @Expose()
  scope: LeaderboardScopeParam;

  @ApiProperty({
    type: [LeaderboardRowDto],
    description: 'Top three, for the podium.',
  })
  @Expose()
  @Type(() => LeaderboardRowDto)
  podium: LeaderboardRowDto[];

  @ApiProperty({ type: [LeaderboardRowDto] })
  @Expose()
  @Type(() => LeaderboardRowDto)
  rows: LeaderboardRowDto[];

  @ApiProperty({ type: LeaderboardMeDto })
  @Expose()
  @Type(() => LeaderboardMeDto)
  me: LeaderboardMeDto;

  @ApiProperty({
    type: [LeaderboardRowDto],
    description: 'The rows either side of the player, for the neighbour strip.',
  })
  @Expose()
  @Type(() => LeaderboardRowDto)
  neighbours: LeaderboardRowDto[];

  @Expose()
  totalPlayers: number;

  @ApiProperty({
    description:
      'How many players share the top score — 1 when first place is ' +
      'undisputed, 0 on an empty board. Lets a client caption a tied podium.',
  })
  @Expose()
  tiedAtTop: number;
}
