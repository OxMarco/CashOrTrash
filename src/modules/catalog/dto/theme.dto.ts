import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

import { THEME_ICONS } from '../theme-icons';

export class ThemeDto {
  @Expose()
  id: number;

  @ApiProperty({ example: 'everyday-stuff' })
  @Expose()
  slug: string;

  @ApiProperty({ example: 'Everyday stuff' })
  @Expose()
  name: string;

  @ApiProperty({
    enum: THEME_ICONS,
    description:
      'Glyph for the card. A name from a fixed set the client ships; anything ' +
      'else it does not recognise falls back to its default.',
  })
  @Expose()
  iconName: string;

  @ApiProperty({ description: 'Mystery mix draws from every theme.' })
  @Expose()
  isMystery: boolean;

  @ApiProperty({ example: 0.1, description: '0.1 == "+10% point bonus".' })
  @Expose()
  bonusPct: number;

  @ApiProperty({
    example: 'Avg ±22%',
    nullable: true,
    description: 'Null until the theme has enough rounds to be honest about.',
  })
  @Expose()
  difficultyLabel: string | null;

  @ApiProperty({
    description: 'Playable item count; a theme needs at least 5.',
  })
  @Expose()
  itemCount: number;
}
