import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

import { PushPlatform } from '../entities/push-token.entity';

export class RegisterPushTokenDto {
  @ApiProperty({ enum: PushPlatform })
  @IsEnum(PushPlatform)
  platform: PushPlatform;

  @ApiProperty()
  @IsString()
  @Length(8, 512)
  token: string;

  @ApiPropertyOptional({
    description:
      'Minutes east of UTC. Buckets the nudge so it lands in the player’s evening.',
    example: 120,
  })
  @IsOptional()
  @IsInt()
  @Min(-720)
  @Max(840)
  timezoneOffsetMinutes?: number;
}

export class PushRegistrationDto {
  @ApiProperty()
  @Expose()
  registered: boolean;

  @ApiProperty()
  @Expose()
  platform: PushPlatform;
}
