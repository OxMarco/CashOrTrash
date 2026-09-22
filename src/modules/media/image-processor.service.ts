import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';

/** The one derivative shape the catalogue serves: 1080×864, 5:4 landscape. */
export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 864;

/**
 * The source tree is operator-controlled, but a malformed or accidentally huge
 * listing image must not be able to exhaust the container outside V8's heap.
 * Forty megapixels comfortably covers the shipped catalogue while putting a
 * hard ceiling on the native allocation sharp may make while decoding it.
 */
export const MAX_SOURCE_PIXELS = 40_000_000;

/**
 * Quality 82 is a re-encode, not a resize — the pixels are the source's. WebP
 * because `item.photoUrl` promises `.webp` and the app fetches that path.
 */
const WEBP = { quality: 82, effort: 5 } as const;

export type ImageRejection =
  | 'not-an-image'
  | 'animated'
  | 'too-large'
  | 'decode-failed'
  | 'unsupported-format';

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
}

@Injectable()
export class ImageProcessor {
  /**
   * The stored derivative: upright, stripped of metadata, and fitted to the
   * game's 5:4 card. `attention` chooses the crop using sharp's entropy and
   * saturation heuristic, which is deterministic and avoids maintaining two
   * subtly different crops in the native and web clients.
   */
  async normalise(input: Buffer): Promise<ProcessedImage> {
    const metadata = await this.probe(input);

    // `pages` is how sharp reports animation across GIF, WebP and APNG alike.
    // An animated source would be flattened to its first frame silently, and a
    // still frame lifted from an animation is rarely the photograph of record.
    if ((metadata.pages ?? 1) > 1) {
      throw new ImageRejectedError('animated', 'Animated images are not used');
    }

    // `metadata()` describes the file, not the upright picture, so a photo
    // tagged with a quarter-turn reports its dimensions the other way round.
    // Swapping here is far cheaper than decoding the image to measure it, and
    // it is the same picture `.rotate()` is about to produce.
    const quarterTurned = (metadata.orientation ?? 1) >= 5;
    const width = (quarterTurned ? metadata.height : metadata.width) ?? 0;
    const height = (quarterTurned ? metadata.width : metadata.height) ?? 0;

    if (width * height > MAX_SOURCE_PIXELS) {
      throw new ImageRejectedError(
        'too-large',
        `Image is ${width}×${height}; sources may contain at most ${MAX_SOURCE_PIXELS} pixels`,
      );
    }

    // Everything the pipeline does, in two calls. `.rotate()` bakes in the EXIF
    // orientation, which has to happen because the tag that carried it does not
    // survive the next line: sharp strips metadata unless asked to keep it, so a
    // marketplace listing's GPS location and photographer's name stay out of a
    // file the game serves publicly.
    //
    // Guarded, because `probe()` only read the header. A file can describe
    // itself perfectly and still fail here — a download that stopped early, a
    // codec this build of libvips has no decoder for — and an escaping sharp
    // error is a 500 on an upload the operator could have fixed by picking a
    // different file.
    let bytes: Buffer;
    try {
      bytes = await sharp(input, {
        limitInputPixels: MAX_SOURCE_PIXELS,
      })
        .rotate()
        .resize(CARD_WIDTH, CARD_HEIGHT, {
          fit: 'cover',
          position: 'attention',
        })
        .webp(WEBP)
        .toBuffer();
    } catch (error) {
      throw this.undecodable(metadata, error as Error);
    }

    return { digest: sha256Hex(bytes), bytes };
  }

  /**
   * Why a file that parsed as an image would not decode.
   *
   * HEIC is the case worth naming. It is what an iPhone hands over unless the
   * owner has changed a setting, and sharp's prebuilt libvips reads its header
   * — dimensions, orientation, everything — while carrying no HEVC decoder to
   * turn that into pixels. "Could not decode image" would send the operator
   * looking for a corrupt file; the fix is a two-second export.
   *
   * Decided from the failure rather than refused up front on `compression`, so
   * a build of libvips that *does* carry the decoder simply works.
   */
  private undecodable(metadata: Metadata, error: Error): ImageRejectedError {
    if (metadata.format === 'heif' && metadata.compression === 'hevc') {
      return new ImageRejectedError(
        'unsupported-format',
        'HEIC photographs cannot be decoded here. Export the picture as JPEG ' +
          'or PNG and upload that.',
      );
    }
    return new ImageRejectedError(
      'decode-failed',
      `Could not decode image: ${error.message.split('\n')[0]}`,
    );
  }

  private async probe(input: Buffer): Promise<Metadata> {
    let metadata: Metadata;
    try {
      // Deliberately without the pixel limit. `metadata()` reads the header and
      // decodes nothing, so it is safe at any declared size — and running it
      // limited would collapse "claims to be 20000×20000" into the same
      // undifferentiated decode failure as "is not an image at all". The size
      // check above wants to tell those apart, because they say different
      // things about the source that served them.
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

    return metadata;
  }
}

/**
 * The full SHA-256 of a photograph's bytes — its content address in the store.
 *
 * Named for what it is rather than `digestOf`, which is the name of the
 * 16-character JSON change detector in `common/serialization`. The two are not
 * interchangeable: that one is truncated and hashes a serialisation, this one
 * must match `DIGEST_PATTERN` to the character, and an auto-import picking the
 * wrong one would compile and then address every photo at a path that does not
 * exist.
 */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
