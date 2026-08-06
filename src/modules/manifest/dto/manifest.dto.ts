import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

/**
 * What a client holds on disk, and whether it is still current.
 *
 * One opaque version per cacheable resource. A client stores the version it
 * last successfully fetched each resource at, polls this, and refetches the
 * ones whose version moved. That is the whole contract — the strings mean
 * nothing beyond "same" or "different", and clients must not parse them.
 */
export class CacheManifestDto {
  @ApiProperty({
    example: 'b3f1c0a92d4e77aa',
    description:
      'Version of GET /themes. Moves whenever that payload would differ — a ' +
      'category appearing or being retired, a difficulty label changing, or ' +
      'any item being added or removed, since the mystery row carries a count ' +
      'of the whole catalogue.',
  })
  @Expose()
  catalog: string;

  @ApiProperty({
    example: '7c21ab90ff3d1e64',
    description:
      'Version of GET /currencies. Moves when a rate is refreshed, which is ' +
      'hourly at most.',
  })
  @Expose()
  currency: string;
}
