/**
 * Regenerates `assets/landing.html`, the marketing page served at `/`.
 *
 * The served page is one self-contained file: the landing route's CSP allows
 * inline style, inline script and `data:` fonts and images, and nothing else,
 * so every typeface and photo on the page has to travel inside the document.
 * Hand-editing a file that is mostly base64 is hopeless, hence this split:
 * `scripts/landing/landing.html` is the page as a person edits it, with
 * `%%FONT:name%%` and `%%PHOTO:name%%` markers where the data URIs go, and
 * this script fills them in and writes the result to `assets/`.
 *
 * Fonts are read from the app package, the same way the OG card does it, so
 * the page and the app set the same faces. Run from a checkout where `app/`
 * has its dependencies installed. Photos are the committed JPEG/PNG sources in
 * `scripts/landing/photos/`, re-encoded to WebP at the size the page shows
 * them, so a 100 KB source costs the page a few KB.
 *
 * Run: npm run assets:landing
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, 'landing');
const assets = join(here, '..', 'assets');
const fonts = join(
  here,
  '..',
  '..',
  'app',
  'node_modules',
  '@expo-google-fonts',
);

const FONTS = {
  caprasimo: 'caprasimo/400Regular/Caprasimo_400Regular.ttf',
  'figtree-400': 'figtree/400Regular/Figtree_400Regular.ttf',
  'figtree-600': 'figtree/600SemiBold/Figtree_600SemiBold.ttf',
  'figtree-700': 'figtree/700Bold/Figtree_700Bold.ttf',
  'space-grotesk-700': 'space-grotesk/700Bold/SpaceGrotesk_700Bold.ttf',
};

/**
 * Longest edge in CSS px the page ever shows each photo at, doubled for
 * high-density screens. The car is the hero demo image; the rest are
 * thumbnails and category chips.
 */
const PHOTOS = {
  car: { file: 'car.jpg', width: 1040, quality: 72 },
  wine: { file: 'wine.jpg', width: 320, quality: 72 },
  card: { file: 'card.jpg', width: 320, quality: 72 },
  yacht: { file: 'yacht.jpg', width: 320, quality: 72 },
  ipad: { file: 'ipad.jpg', width: 320, quality: 72 },
  logo: { file: 'logo.png', width: 144, quality: 90 },
};

const fontUri = async (name) => {
  const bytes = await readFile(join(fonts, FONTS[name]));
  return `data:font/ttf;base64,${bytes.toString('base64')}`;
};

const photoUri = async (name) => {
  const { file, width, quality } = PHOTOS[name];
  const bytes = await sharp(await readFile(join(source, 'photos', file)))
    .resize({ width, withoutEnlargement: true })
    .webp({ quality, effort: 6 })
    .toBuffer();
  return {
    uri: `data:image/webp;base64,${bytes.toString('base64')}`,
    bytes: bytes.length,
  };
};

let html = await readFile(join(source, 'landing.html'), 'utf8');

const markers = [...html.matchAll(/%%(FONT|PHOTO):([a-z0-9-]+)%%/g)];
const seen = new Map();
for (const [marker, kind, name] of markers) {
  if (seen.has(marker)) continue;
  const table = kind === 'FONT' ? FONTS : PHOTOS;
  if (!(name in table))
    throw new Error(`Unknown ${kind.toLowerCase()} "${name}" in landing.html`);
  if (kind === 'FONT') {
    seen.set(marker, await fontUri(name));
  } else {
    const { uri, bytes } = await photoUri(name);
    console.log(`photo ${name}: ${bytes} bytes`);
    seen.set(marker, uri);
  }
}

for (const [marker, uri] of seen) html = html.split(marker).join(uri);

// The page is served as-is and referenced only by class, so a marker that
// slipped through would ship as literal text in a `url()`.
if (/%%(FONT|PHOTO):/.test(html))
  throw new Error('Unreplaced marker in landing.html');

await writeFile(join(assets, 'landing.html'), html);
console.log(`assets/landing.html: ${Buffer.byteLength(html)} bytes`);
