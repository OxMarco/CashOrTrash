import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';

import { CatalogService } from '../catalog/catalog.service';
import { CurrencyService } from '../currency/currency.service';
import { Item } from '../catalog/entities/item.entity';
import { Theme } from '../catalog/entities/theme.entity';
import { MYSTERY_THEME_SLUG } from '../catalog/mystery';
import { ImageProcessor } from '../media/image-processor.service';
import { MediaStore } from '../media/media-store';
import { AdminCatalogService, slugify } from './admin-catalog.service';

/**
 * The mystery mix is a reserved slug rather than a category, and the portal is
 * the one place a name that collides with it can be typed. A category taking
 * that slug would shadow the mix in every installed build — the picker keys the
 * row on the slug, and the server would deal that one category's items under
 * the mix's name — so the collision is refused at the point of creation, where
 * it is still one operator seeing an error message.
 */
function service(existingSlug: string | null = null) {
  const themes = {
    findOne: jest.fn().mockResolvedValue(existingSlug ? { id: 7 } : null),
    create: jest.fn().mockImplementation((value: Partial<Theme>) => value),
    save: jest
      .fn()
      .mockImplementation((value: Partial<Theme>) =>
        Promise.resolve({ id: 7, ...value }),
      ),
  } as unknown as Repository<Theme>;

  return new AdminCatalogService(
    {} as unknown as Repository<Item>,
    themes,
    {} as unknown as ImageProcessor,
    {} as unknown as MediaStore,
    {
      invalidateThemes: jest.fn().mockResolvedValue(undefined),
    } as unknown as CatalogService,
    {} as unknown as CurrencyService,
    { add: jest.fn() } as unknown as Queue,
    {
      getOrThrow: () => ({ root: '/tmp/media', publicBase: '' }),
    } as unknown as ConfigService,
  );
}

describe('a category named like the mystery mix', () => {
  // The guard is only worth anything if this is the slug the portal would
  // actually produce from the name an operator would actually type.
  it('is the slug "Mystery mix" slugifies to', () => {
    expect(slugify('Mystery mix')).toBe(MYSTERY_THEME_SLUG);
  });

  it('is refused rather than created', async () => {
    await expect(
      service().createCategory({ name: 'Mystery mix' }),
    ).rejects.toThrow(/reserved/i);
  });

  it('is still refused when no category holds the slug', async () => {
    // Not a duplicate-name conflict: there is no row to collide with, which is
    // the whole point — the mix has never been one.
    const themes = service();
    await expect(
      themes.createCategory({ name: 'MYSTERY MIX' }),
    ).rejects.toThrow(/reserved/i);
  });

  it('lets every other name through', async () => {
    const created = await service().createCategory({ name: 'Mystery novels' });

    expect(created.slug).toBe('mystery-novels');
  });
});
