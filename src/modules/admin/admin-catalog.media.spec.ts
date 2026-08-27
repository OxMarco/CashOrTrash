import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Queue } from 'bullmq';

import { CatalogService } from '../catalog/catalog.service';
import { Item } from '../catalog/entities/item.entity';
import { Theme } from '../catalog/entities/theme.entity';
import { ImageProcessor } from '../media/image-processor.service';
import { MediaStore } from '../media/media-store';
import { AdminCatalogService } from './admin-catalog.service';

/**
 * The store is content-addressed, so two uploads of the same photograph share
 * one path and a failed create cannot tell whether the blob under that path is
 * its own or a concurrent request's. Neither of these cases deletes: reclaiming
 * orphans is `MediaGcService`'s job, and its grace period is what makes the
 * decision safe.
 */
describe('AdminCatalogService media cleanup', () => {
  it('leaves the blob for the graced sweep when the item insert fails', async () => {
    const digest = 'a'.repeat(64);
    const items = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((value) => value),
      save: jest.fn().mockRejectedValue(new Error('insert failed')),
      exists: jest.fn().mockResolvedValue(false),
    } as unknown as Repository<Item>;
    const themes = {
      findOne: jest.fn().mockResolvedValue({ id: 1, name: 'Watches' }),
    } as unknown as Repository<Theme>;
    const store = {
      put: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    } as unknown as MediaStore;
    const processor = {
      normalise: jest.fn().mockResolvedValue({
        digest,
        bytes: Buffer.from('processed'),
      }),
    } as unknown as ImageProcessor;
    const service = new AdminCatalogService(
      items,
      themes,
      processor,
      store,
      {} as CatalogService,
      {} as Queue,
      {
        getOrThrow: () => ({ root: '/tmp/media', publicBase: '' }),
      } as unknown as ConfigService,
    );

    await expect(
      service.createItem(
        {
          themeId: 1,
          title: 'Watch',
          conditionLine: 'Used',
          priceCents: 10_000,
        },
        Buffer.from('upload'),
      ),
    ).rejects.toThrow('insert failed');

    // Deleting here would race a concurrent request that has passed its own
    // duplicate check on this same digest but not yet committed.
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('preserves a blob another concurrent insert now references', async () => {
    const digest = 'b'.repeat(64);
    const items = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((value) => value),
      save: jest.fn().mockRejectedValue(new Error('unique violation')),
      exists: jest.fn().mockResolvedValue(true),
    } as unknown as Repository<Item>;
    const store = {
      put: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    } as unknown as MediaStore;
    const service = new AdminCatalogService(
      items,
      {
        findOne: jest.fn().mockResolvedValue({ id: 1, name: 'Watches' }),
      } as unknown as Repository<Theme>,
      {
        normalise: jest.fn().mockResolvedValue({
          digest,
          bytes: Buffer.from('processed'),
        }),
      } as unknown as ImageProcessor,
      store,
      {} as CatalogService,
      {} as Queue,
      {
        getOrThrow: () => ({ root: '/tmp/media', publicBase: '' }),
      } as unknown as ConfigService,
    );

    await expect(
      service.createItem(
        {
          themeId: 1,
          title: 'Watch',
          conditionLine: 'Used',
          priceCents: 10_000,
        },
        Buffer.from('upload'),
      ),
    ).rejects.toThrow('unique violation');

    expect(store.delete).not.toHaveBeenCalled();
  });
});
