/**
 * Regenerates `assets/og-card.png` — the image every shared result unfurls to.
 *
 * The card is committed rather than rendered at boot for the same reason the
 * photo placeholder is: it changes about once a year, and rasterising an SVG
 * with two embedded fonts on every cold start would be work done thousands of
 * times to produce one unchanging file.
 *
 * Rendered with resvg directly rather than through sharp. sharp's SVG path
 * resolves `font-family` against fonts installed on the machine and silently
 * ignores an `@font-face` data URI — the first cut of this card shipped a
 * fallback sans and looked like a different product. resvg takes font buffers
 * as an explicit input, which is the only way to guarantee the card renders in
 * Caprasimo and Figtree on a machine that has neither installed.
 *
 * The fonts are read from the app package, so run this from a checkout where
 * `app/` has its dependencies installed. `@resvg/resvg-js` is a devDependency
 * and the PNG is committed, so neither reaches production.
 *
 * Run: node scripts/generate-og-card.mjs
 */
import { Resvg } from '@resvg/resvg-js';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', 'assets');
const fonts = join(here, '..', '..', 'app', 'node_modules', '@expo-google-fonts');

// 1.91:1, the ratio every unfurl crops to. Anything outside the middle band is
// liable to be trimmed on one client or another, so nothing that carries
// meaning goes near an edge.
const WIDTH = 1200;
const HEIGHT = 630;

// The Organic tokens, matching the app's ds/styles.css.
const CREAM = '#f5ead8';
const ACCENT = '#c67139';
const ACCENT_INK = '#8a4a1f';
const ACCENT_SOFT = '#f2dcc4';
const SAGE = '#7a8a5e';
const SAGE_INK = '#4c5836';
const NEUTRAL = '#cdb994';
const TEXT = '#201e1d';

const FONT_FILES = [
  join(fonts, 'caprasimo', '400Regular', 'Caprasimo_400Regular.ttf'),
  join(fonts, 'figtree', '400Regular', 'Figtree_400Regular.ttf'),
  join(fonts, 'figtree', '500Medium', 'Figtree_500Medium.ttf'),
];

const card = () => {
  // The slider is the game in one graphic: a span you chose, and the price
  // landing inside it. Drawn to the same proportions as the real control —
  // 6px track, 14px span, 32px thumbs — scaled up for the card.
  const trackY = 470;
  const trackLeft = 110;
  const trackRight = 1090;
  const spanFrom = 430;
  const spanTo = 760;
  const priceAt = 640;

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${CREAM}"/>

  <circle cx="1080" cy="120" r="190" fill="${ACCENT_SOFT}" opacity="0.55"/>
  <circle cx="1145" cy="60" r="95" fill="${ACCENT_SOFT}" opacity="0.5"/>

  <text x="110" y="185" font-family="Caprasimo" font-size="76" fill="${ACCENT_INK}">CashOrTrash</text>
  <text x="112" y="248" font-family="Figtree" font-size="31" fill="${TEXT}" opacity="0.72">Guess what stuff costs. Bet a range, not a number.</text>

  <text x="110" y="392" font-family="Caprasimo" font-size="94" fill="${TEXT}">$450</text>
  <rect x="372" y="332" rx="31" ry="31" width="300" height="62" fill="#dfe5d0"/>
  <text x="522" y="373" font-family="Figtree" font-weight="500" font-size="28" fill="${SAGE_INK}" text-anchor="middle">Inside your range</text>

  <rect x="${trackLeft}" y="${trackY - 3}" width="${trackRight - trackLeft}" height="6" rx="3" fill="${NEUTRAL}"/>
  <rect x="${spanFrom}" y="${trackY - 10}" width="${spanTo - spanFrom}" height="20" rx="10" fill="${ACCENT_SOFT}" stroke="${ACCENT}" stroke-width="3"/>
  <rect x="${priceAt - 3}" y="${trackY - 42}" width="6" height="84" rx="3" fill="${SAGE}"/>
  <circle cx="${spanFrom}" cy="${trackY}" r="21" fill="${CREAM}" stroke="${ACCENT}" stroke-width="6"/>
  <circle cx="${spanTo}" cy="${trackY}" r="21" fill="${CREAM}" stroke="${ACCENT}" stroke-width="6"/>

  <text x="${trackLeft}" y="${trackY + 78}" font-family="Figtree" font-size="24" fill="${TEXT}" opacity="0.55">$50</text>
  <text x="${trackRight}" y="${trackY + 78}" font-family="Figtree" font-size="24" fill="${TEXT}" opacity="0.55" text-anchor="end">$1,500</text>
  <text x="${(spanFrom + spanTo) / 2}" y="${trackY + 78}" font-family="Figtree" font-weight="500" font-size="24" fill="${ACCENT_INK}" text-anchor="middle">your $380–$520</text>
</svg>`);
};

// Fail here rather than in a feed. resvg silently ignores font options it does
// not recognise and quietly falls back to a system face, which is how the first
// two cuts of this card shipped in Helvetica without anything complaining.
for (const file of FONT_FILES) await readFile(file);

const renderer = new Resvg(card().toString('utf8'), {
  fitTo: { mode: 'width', value: WIDTH },
  font: {
    fontFiles: FONT_FILES,
    // No system fonts at all, so a missing family cannot resolve to whatever
    // the machine happens to have. Combined with the check below, a card that
    // renders is a card in the right typefaces.
    loadSystemFonts: false,
    defaultFontFamily: 'Figtree',
  },
});
const png = renderer.render().asPng();
await writeFile(join(assets, 'og-card.png'), png);
console.log(`assets/og-card.png — ${WIDTH}x${HEIGHT}, ${(png.length / 1024).toFixed(1)} KB`);
