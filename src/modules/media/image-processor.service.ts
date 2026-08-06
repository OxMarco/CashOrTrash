import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import sharp, { type Metadata, type Sharp } from 'sharp';

/**
 * The "washed" treatment from the design bundle: desaturated, low contrast, so
 * a photograph sits into the warm cream page rather than shouting off it. See
 * `sources/README.md` — "Photos: washed (desaturated, low contrast, rounded
 * corners) so they sit into the warm page".
 *
 * Applied once when the photo is fetched and stored as a derivative, rather than having every
 * client reimplement the filter and drift. These five numbers are therefore a
 * design decision baked into the bytes: changing them means reprocessing the
 * catalogue, so they should be signed off against
 * `sources/screenshots/04-gameplay.png` rather than nudged.
 */
const SATURATION = 0.55;
const BRIGHTNESS = 1.04;
/** out = A·in + B. The contrast half of "washed": flatten, then lift the floor. */
const LINEAR_A = 0.82;
const LINEAR_B = 18;

/**
 * Every derivative is cropped to one shape: 5:4, landscape.
 *
 * The card that renders these is full-bleed width and a fixed 280pt tall, which
 * on a 390pt frame is about 5:4 — and `ItemPhoto` draws it with `cover`. So
 * something was always going to crop. Left to the client that is a blind
 * centre-crop of whatever shape arrived, which is how a portrait watch
 * photograph loses its dial; done here it is `attention`, which keeps the
 * region sharp detail actually clusters in, and it is inspectable because the
 * result is a stored file rather than a runtime decision.
 *
 * A uniform shape is also the point of a catalogue: mixed aspect ratios make
 * the picker read as a scrapbook however good the individual photographs are.
 */
const CARD_ASPECT = 5 / 4;
const CARD_WIDTH = 1080;
const THUMB_WIDTH = 320;

/**
 * The largest 5:4 box a source can fill without being enlarged, capped at
 * `maxWidth`.
 *
 * Needed because sharp's `withoutEnlargement` does not do this. Combined with
 * `fit: 'cover'` it does not scale the target box down to fit — it declines to
 * resize at all and hands back the original shape. Most of this catalogue is
 * smaller than 1080×864 (product photography is routinely 500×610 or 900×520),
 * so relying on it would leave nearly every photograph uncropped and the
 * uniform card shape would exist only for the few oversized ones.
 *
 * Computing the box instead keeps both properties at once: every derivative is
 * 5:4, and no derivative is upscaled into blur.
 */
function cardBox(
  width: number,
  height: number,
  maxWidth: number,
): { width: number; height: number } {
  const box = Math.min(maxWidth, width, height * CARD_ASPECT);
  return { width: Math.round(box), height: Math.round(box / CARD_ASPECT) };
}
/**
 * Below this an item is unrecognisable on a 390pt phone frame at 280pt tall,
 * and the game is "can you price *that*" — an unreadable photo is a round the
 * player loses to the photograph rather than to the item.
 *
 * Measured on the **card this produces**, not on the source's shorter edge.
 * That distinction used to not exist: before every derivative was cropped to
 * 5:4, the shorter edge was a fair proxy for what a player would see. It stopped
 * being one the moment the output became landscape, and the two then disagreed
 * in a way that had nothing to do with legibility — a portrait 500×610 passed a
 * 450px floor and produced a 500×400 card, while a landscape 480×400 failed it
 * and would have produced 480×384. Two cards a player cannot tell apart, one
 * imported and one rejected, decided by which way round the photographer held
 * the camera.
 *
 * 384 because that is the shortest card the catalogue already ships, so this
 * admits what is demonstrably good enough and nothing weaker. A thumbnail is
 * still firmly out: 270×270 crops to 270×216 and misses by a wide margin.
 *
 * Note what this does *not* fix — a source can only be cropped, never enlarged,
 * so the floor is a statement about pixels the photograph actually has.
 * Upscaling a small one to clear it adds pixels without adding detail, and
 * measurably lowers detail-per-pixel below what is already shipping.
 */
const MIN_CARD_HEIGHT = 384;

const WEBP = { quality: 82, effort: 5 } as const;

/**
 * A 40 MP ceiling on the *decoded* dimensions. A few hundred KB of crafted
 * input can otherwise decode to gigabytes, and sharp decodes outside the V8
 * heap where `--max-old-space-size` cannot see it — the cgroup kills the
 * process instead, which is why this runs in the worker and not the API.
 */
const MAX_INPUT_PIXELS = 40e6;

export type ImageRejection =
  'not-an-image' | 'animated' | 'too-small' | 'too-large' | 'decode-failed';

export class ImageRejectedError extends Error {
  constructor(
    readonly reason: ImageRejection,
    message: string,
  ) {
    super(message);
    this.name = 'ImageRejectedError';
  }
}

export interface ProcessedImage {
  /** sha256 of `bytes` — the filename, the ETag, and the whole identity. */
  digest: string;
  bytes: Buffer;
  thumbDigest: string;
  thumbBytes: Buffer;
  width: number;
  height: number;
  /** 64-bit dHash as 16 hex characters. */
  phash: string;
}

@Injectable()
export class ImageProcessor {
  async wash(input: Buffer): Promise<ProcessedImage> {
    const metadata = await this.probe(input);

    // `pages` is how sharp reports animation across GIF, WebP and APNG alike.
    // An animated source would be flattened to its first frame silently, and a
    // still frame lifted from an animation is rarely the photograph of record.
    if ((metadata.pages ?? 1) > 1) {
      throw new ImageRejectedError('animated', 'Animated images are not used');
    }

    const upright = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .toColourspace('srgb');

    // `metadata()` describes the file, not the pipeline, so a portrait photo
    // tagged with a quarter-turn reports its dimensions the other way round.
    // Swapping here is far cheaper than decoding the image to measure it.
    const quarterTurned = (metadata.orientation ?? 1) >= 5;
    const width = (quarterTurned ? metadata.height : metadata.width) ?? 0;
    const height = (quarterTurned ? metadata.width : metadata.height) ?? 0;

    const card = cardBox(width, height, CARD_WIDTH);
    const thumb = cardBox(width, height, THUMB_WIDTH);

    if (card.height < MIN_CARD_HEIGHT) {
      throw new ImageRejectedError(
        'too-small',
        `Image is ${width}×${height}, which crops to a ${card.width}×${card.height} card; ` +
          `the card must be at least ${MIN_CARD_HEIGHT}px tall`,
      );
    }

    const [bytes, thumbBytes, phash] = await Promise.all([
      this.render(upright.clone(), card),
      this.render(upright.clone(), thumb),
      this.dHash(upright.clone()),
    ]);

    const rendered = await sharp(bytes).metadata();

    return {
      digest: digestOf(bytes),
      bytes,
      thumbDigest: digestOf(thumbBytes),
      thumbBytes,
      width: rendered.width ?? width,
      height: rendered.height ?? height,
      phash,
    };
  }

  /**
   * The washed derivative at a given size, cropped to fill it.
   *
   * `withoutEnlargement` matters: an 800px source upscaled to 1080 is a
   * blurrier picture in a bigger file. It keeps the 5:4 shape either way — a
   * source too small to fill the frame yields a smaller 5:4 image rather than a
   * differently-shaped one — so the aspect ratio is a guarantee and not a
   * best-effort.
   *
   * sharp strips metadata unless asked to keep it, which is the behaviour we
   * want — EXIF from a marketplace listing can carry a GPS location and a
   * photographer's name into a file the game serves publicly.
   */
  private render(
    image: Sharp,
    box: { width: number; height: number },
  ): Promise<Buffer> {
    return image
      .resize(box.width, box.height, {
        fit: 'cover',
        position: sharp.strategy.attention,
      })
      .modulate({ saturation: SATURATION, brightness: BRIGHTNESS })
      .linear(LINEAR_A, LINEAR_B)
      .webp(WEBP)
      .toBuffer();
  }

  /**
   * Difference hash: 9×8 greyscale, then one bit per horizontal neighbour pair.
   * Robust to rescaling and recompression, which is exactly the case that
   * matters — the same stock photograph arriving from two different sources.
   *
   * Computed from the *pre-wash* upright image so the hash describes the
   * photograph rather than our filter, and stays comparable if the filter
   * constants ever move.
   */
  private async dHash(image: Sharp): Promise<string> {
    const raw = await image
      .resize(9, 8, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer();

    let hex = '';
    for (let row = 0; row < 8; row += 1) {
      let byte = 0;
      for (let col = 0; col < 8; col += 1) {
        const left = raw[row * 9 + col];
        const right = raw[row * 9 + col + 1];
        byte = (byte << 1) | (left > right ? 1 : 0);
      }
      hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
  }

  private async probe(input: Buffer): Promise<Metadata> {
    let metadata: Metadata;
    try {
      // Deliberately without the pixel limit. `metadata()` reads the header and
      // decodes nothing, so it is safe at any declared size — and running it
      // limited would collapse "claims to be 20000×20000" into the same
      // undifferentiated decode failure as "is not an image at all". The
      // explicit check below wants to tell those apart, because they say
      // different things about the source that served them.
      metadata = await sharp(input, { limitInputPixels: false }).metadata();
    } catch (error) {
      throw new ImageRejectedError(
        'decode-failed',
        `Could not decode image: ${(error as Error).message}`,
      );
    }

    if (!metadata.format || !metadata.width || !metadata.height) {
      throw new ImageRejectedError(
        'not-an-image',
        'Bytes carry no recognisable image header',
      );
    }

    // Judged on the *declared* dimensions, before a single pixel is decoded.
    // `limitInputPixels` on the pipeline is the backstop, but it fires partway
    // through a decode that has already reserved the memory — and the memory is
    // the thing being defended against. A few hundred KB can claim a canvas of
    // gigabytes.
    if (metadata.width * metadata.height > MAX_INPUT_PIXELS) {
      throw new ImageRejectedError(
        'too-large',
        `Image declares ${metadata.width}×${metadata.height}, over the ${MAX_INPUT_PIXELS / 1e6} MP ceiling`,
      );
    }

    return metadata;
  }
}

/** Hamming distance between two dHashes, for near-duplicate detection. */
export function phashDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new Error('Hashes differ in length');

  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    let xor = Number.parseInt(a[i], 16) ^ Number.parseInt(b[i], 16);
    while (xor > 0) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

export function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
