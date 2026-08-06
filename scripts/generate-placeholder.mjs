/**
 * Regenerates `assets/photo-pending.webp` from `assets/photo-pending.svg`.
 *
 * The webp is committed rather than produced at boot because its sha256 IS its
 * URL, and that URL is written into `item.photoUrl` by a migration. sharp's
 * encoder is not promised to be byte-identical across versions, so generating
 * it at runtime would eventually mint a digest no stored row points at.
 *
 * After running this, update PLACEHOLDER_DIGEST in
 * `src/modules/media/placeholder.ts` to the digest printed below — a spec
 * asserts the two agree, so a forgotten update fails the build rather than
 * silently 404ing every item photo.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

const bytes = await sharp(await readFile(join(assets, 'photo-pending.svg')))
  .webp({ quality: 82, effort: 5 })
  .toBuffer();

await writeFile(join(assets, 'photo-pending.webp'), bytes);

const digest = createHash('sha256').update(bytes).digest('hex');
console.log(`${bytes.length} bytes`);
console.log(`PLACEHOLDER_DIGEST = '${digest}'`);
