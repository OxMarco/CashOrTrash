import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { digestOf } from './image-processor.service';
import { MediaStore } from './media-store';

/**
 * The sha256 of `assets/photo-pending.webp`.
 *
 * Hard-coded rather than computed at boot because this digest is stored in
 * `item.photoUrl` on every seeded row, so it is data rather than a detail of
 * the artwork. `placeholder.spec.ts` asserts the file still hashes to this —
 * editing the artwork without regenerating the constant fails the build instead
 * of silently 404ing every photo in the catalogue.
 */
export const PLACEHOLDER_DIGEST =
  '8bda18e708ad3f919237e09a761fa5f8a6e4ef79686a8ec1c21b8cca71e7b7c8';

export const PLACEHOLDER_PHOTO_URL = `/media/items/${PLACEHOLDER_DIGEST}.webp`;

/** Resolves under both `dist/modules/media` and `src/modules/media`. */
export const PLACEHOLDER_ASSET_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'assets',
  'photo-pending.webp',
);

/**
 * Copies the placeholder into the media store on boot, if it is not already
 * there.
 *
 * The alternative — special-casing this one digest in `MediaController` — would
 * put a branch in the serving path forever to save one 4 KB write on startup,
 * and would mean the store's contents no longer account for everything it
 * serves.
 *
 * A failure here is logged, not thrown. A read-only volume or a missing asset
 * should degrade to broken images, which is where the catalogue already is; it
 * should not stop the API from starting and take the whole game down with it.
 */
@Injectable()
export class PlaceholderSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlaceholderSeeder.name);

  constructor(private readonly store: MediaStore) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      if (await this.store.has(PLACEHOLDER_DIGEST)) return;

      const bytes = await readFile(PLACEHOLDER_ASSET_PATH);
      const actual = digestOf(bytes);

      if (actual !== PLACEHOLDER_DIGEST) {
        this.logger.error(
          `assets/photo-pending.webp hashes to ${actual}, not ${PLACEHOLDER_DIGEST}. ` +
            'Run `npm run assets:placeholder` and update PLACEHOLDER_DIGEST.',
        );
        return;
      }

      await this.store.put(PLACEHOLDER_DIGEST, bytes);
      this.logger.log('Placeholder item photo installed');
    } catch (error) {
      this.logger.error(
        `Could not install the placeholder item photo: ${(error as Error).message}`,
      );
    }
  }
}
