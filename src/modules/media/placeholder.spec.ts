import 'reflect-metadata';

import { readFile } from 'node:fs/promises';

import { digestOf } from './image-processor.service';
import {
  PLACEHOLDER_ASSET_PATHS,
  PLACEHOLDER_DIGEST,
  PLACEHOLDER_PHOTO_URL,
} from './placeholder';

describe('the placeholder item photo', () => {
  it('still hashes to the digest every seeded row points at', async () => {
    // If this fails, the artwork was edited without running
    // `npm run assets:placeholder` and updating PLACEHOLDER_DIGEST — which
    // would 404 the photo on every item still on the placeholder. Failing here
    // is the cheap version of finding that out.
    const bytes = await readFile(PLACEHOLDER_ASSET_PATHS[0]);

    expect(digestOf(bytes)).toBe(PLACEHOLDER_DIGEST);
  });

  it('is addressed by a URL the media route will actually accept', () => {
    // The route's pipe takes `<64 hex>.webp` and nothing else, so a malformed
    // constant here would be a 404 no test elsewhere would attribute to it.
    expect(PLACEHOLDER_PHOTO_URL).toMatch(
      /^\/media\/items\/[0-9a-f]{64}\.webp$/,
    );
  });
});
