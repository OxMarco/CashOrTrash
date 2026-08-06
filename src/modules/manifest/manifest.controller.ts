import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { digestOf } from 'src/common/serialization/digest-of';
import { toDto } from 'src/common/serialization/to-dto';
import { CatalogService } from '../catalog/catalog.service';
import { CurrencyService } from '../currency/currency.service';
import { CacheManifestDto } from './dto/manifest.dto';

/**
 * The freshness contract for everything a client keeps on disk.
 *
 * The app persists its theme list and its exchange rates so it opens on real
 * content instead of a spinner, which means it can also open on content the
 * server has since replaced. `staleTime` alone cannot close that: it is a
 * guess made in the client about how long the server stays still, and it is
 * wrong in both directions — too long and a category nobody can play is on
 * the picker, too short and every launch refetches lists that change weekly.
 *
 * This replaces the guess with an answer. One cheap call says which resources
 * moved; the client refetches exactly those and leaves the rest alone.
 *
 * Deliberately not `@Public()`. It is a small fact about the catalogue rather
 * than a secret, but every client that has a cache also has a device session,
 * so making it anonymous would open a surface without buying anything.
 */
@ApiTags('manifest')
@Controller('manifest')
export class ManifestController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly currency: CurrencyService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Cache versions, for a client deciding what to refetch.',
  })
  async manifest(): Promise<CacheManifestDto> {
    return toDto(CacheManifestDto, {
      catalog: await this.catalog.themesVersion(),
      currency: digestOf(this.currency.list()),
    });
  }
}
