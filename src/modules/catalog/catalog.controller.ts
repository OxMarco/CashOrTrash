import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CatalogService } from './catalog.service';
import { ThemeDto } from './dto/theme.dto';

@ApiTags('catalog')
@Controller('themes')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @ApiOperation({ summary: 'Theme picker grid, with difficulty labels.' })
  async themes(): Promise<ThemeDto[]> {
    return this.catalog.listThemes();
  }
}
