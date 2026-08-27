import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class AccessTokenDto {
  @Expose()
  accessToken: string;

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
