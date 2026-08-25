import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

import { THEME_ICONS } from 'src/modules/catalog/theme-icons';

export class AdminLoginDto {
  @IsString()
  @Length(1, 1024)
  password!: string;
}

export class CreateCategoryDto {
  @IsString()
  @Length(1, 64)
  name!: string;

  @IsOptional()
  @IsString()
  @IsIn(THEME_ICONS)
  iconName?: string;

  @IsOptional()
  @IsInt()
  @Min(-10_000)
  @Max(10_000)
  sortOrder?: number;
}

export class SetActiveDto {
  // `unknown` deliberately prevents class-transformer's implicit Boolean
  // conversion from turning the string "false" into true.
  @IsBoolean()
  active!: unknown;
}
