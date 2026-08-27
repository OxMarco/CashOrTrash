import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

import {
  DEFAULT_LANGUAGE,
  Language,
  SUPPORTED_LANGUAGES,
} from '../../catalog/language.constants';
import { PushPlatform } from '../entities/push-token.entity';

export class RegisterPushTokenDto {
  @ApiProperty({ enum: PushPlatform })
  @IsEnum(PushPlatform)
  platform: PushPlatform;

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

  @ApiPropertyOptional({
    enum: SUPPORTED_LANGUAGES,
    default: DEFAULT_LANGUAGE,
    description:
      'The language to send this device’s nudges in. Push copy is composed on ' +
      'the server long after the app last ran, so it cannot be read from the ' +
      'request that receives it.',
  })
  @IsOptional()
  @IsIn(SUPPORTED_LANGUAGES)
  locale?: Language;
}

export class PushRegistrationDto {
  @Expose()
  registered: boolean;

  @Expose()
  platform: PushPlatform;
}
