import { Repository } from 'typeorm';

import { Item } from '../catalog/entities/item.entity';
import {
  digestFromPhotoUrl,
  MEDIA_ORPHAN_GRACE_MS,
  MediaGcService,
} from './media-gc.service';
import { MediaStore, StoredObjectEntry } from './media-store';
import { PLACEHOLDER_DIGEST } from './placeholder';

describe('MediaGcService', () => {
  const sourceDigest = '1'.repeat(64);
  const urlDigest = '2'.repeat(64);
  const orphanDigest = '3'.repeat(64);
  const freshDigest = '4'.repeat(64);

  it('deletes only old, unreferenced objects', async () => {
    const now = new Date('2026-08-27T12:00:00.000Z');
    const old = new Date(now.getTime() - MEDIA_ORPHAN_GRACE_MS - 1);
    const fresh = new Date(now.getTime() - MEDIA_ORPHAN_GRACE_MS + 1);
    const entries: StoredObjectEntry[] = [
      { digest: sourceDigest, modifiedAt: old },
      { digest: urlDigest, modifiedAt: old },
      { digest: PLACEHOLDER_DIGEST, modifiedAt: old },
      { digest: orphanDigest, modifiedAt: old },
      { digest: freshDigest, modifiedAt: fresh },
    ];
    const deleteObject = jest.fn().mockResolvedValue(undefined);
    const store = {
      list: () =>
        (async function* () {
          await Promise.resolve();
          yield* entries;
        })(),
      delete: deleteObject,
    } as unknown as MediaStore;
    const items = {
      find: jest.fn().mockResolvedValue([
        { sourceHash: sourceDigest, photoUrl: '/some/legacy/photo.webp' },
        {
          sourceHash: null,
          photoUrl: `https://cdn.example/media/items/${urlDigest}.webp?v=1`,
        },
      ]),
    } as unknown as Repository<Item>;

    const deleted = await new MediaGcService(items, store).sweep(now);

    expect(deleted).toBe(1);
    expect(deleteObject).toHaveBeenCalledWith(orphanDigest);
  });

  it('extracts only a canonical item-media digest', () => {
    expect(digestFromPhotoUrl(`/media/items/${sourceDigest}.webp`)).toBe(
      sourceDigest,
    );
    expect(digestFromPhotoUrl(`/media/items/${sourceDigest}.jpg`)).toBeNull();
    expect(digestFromPhotoUrl('/media/items/not-a-digest.webp')).toBeNull();
  });
});
