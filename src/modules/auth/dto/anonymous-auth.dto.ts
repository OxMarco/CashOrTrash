import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';

export class AnonymousAuthDto {
  /**
   * Client-generated, stable per install. Re-posting the same id returns the
   * same player, which is what makes a reinstall-free app relaunch seamless.
   */
  @ApiProperty({ example: '6f1c0a3e-8b6e-4a2f-9a9a-1c2d3e4f5a6b' })
  @IsString()
  @Length(8, 128)
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'deviceId must be url-safe',
  })
  deviceId: string;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @Length(16, 4096)
  refreshToken: string;
}

export class TokenPairDto {
  @ApiProperty()
  @Expose()
  accessToken: string;

  @ApiProperty()
  @Expose()
  refreshToken: string;

  @ApiProperty({ description: 'Access token lifetime in seconds.' })
  @Expose()
  expiresIn: number;

  @ApiProperty({ description: 'Set on first sight of a device.' })
  @Expose()
  isNewPlayer: boolean;

  @ApiProperty({
    nullable: true,
    description: 'Null until the name is claimed.',
  })
  @Expose()
  username: string | null;
}
