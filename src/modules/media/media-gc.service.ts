import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Item } from '../catalog/entities/item.entity';
import { MediaStore } from './media-store';
import { PLACEHOLDER_DIGEST } from './placeholder';

export const MEDIA_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1_000;

/** Removes old blobs that no catalogue row can serve. */
@Injectable()
export class MediaGcService {
  private readonly logger = new Logger(MediaGcService.name);

  constructor(
    @InjectRepository(Item) private readonly items: Repository<Item>,
    private readonly store: MediaStore,
  ) {}

  async sweep(now = new Date()): Promise<number> {
    const rows = await this.items.find({
      select: { sourceHash: true, photoUrl: true },
    });
    const referenced = new Set<string>([PLACEHOLDER_DIGEST]);

    for (const row of rows) {
      if (row.sourceHash) referenced.add(row.sourceHash);
      const digest = digestFromPhotoUrl(row.photoUrl);
      if (digest) referenced.add(digest);
    }

    const cutoff = now.getTime() - MEDIA_ORPHAN_GRACE_MS;
    let deleted = 0;
    for await (const entry of this.store.list()) {
      if (entry.modifiedAt.getTime() > cutoff || referenced.has(entry.digest)) {
        continue;
      }
      await this.store.delete(entry.digest);
      deleted += 1;
    }

    if (deleted > 0) this.logger.log(`Deleted ${deleted} orphaned media blobs`);
    return deleted;
  }
}

export function digestFromPhotoUrl(url: string): string | null {
  return (
    /\/media\/items\/([0-9a-f]{64})\.webp(?:[?#].*)?$/.exec(url)?.[1] ?? null
  );
}
