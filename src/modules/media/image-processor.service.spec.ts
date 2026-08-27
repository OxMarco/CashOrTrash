import 'reflect-metadata';

import sharp from 'sharp';

import {
  CARD_HEIGHT,
  CARD_WIDTH,
  digestOf,
  ImageProcessor,
  MAX_SOURCE_PIXELS,
} from './image-processor.service';

/**
 * sharp runs for real here rather than behind a mock. It is fast enough on a
 * single 1080×864 image, and the guarantees worth asserting — that EXIF is
 * actually gone, that the colours are actually untouched — are exactly the ones
 * a mock would assert into existence without testing.
 */
const swatch = (
  width = CARD_WIDTH,
  height = CARD_HEIGHT,
  rgb: { r: number; g: number; b: number } = { r: 200, g: 60, b: 40 },
): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: rgb } })
    .png()
    .toBuffer();

/**
 * A real, small PNG whose IHDR has been rewritten to claim an enormous canvas
 * — which is the actual shape of a decompression bomb: a tiny file that costs a
 * gigabyte to decode.
 *
 * Patched rather than hand-built, because libvips rejects a header-only PNG as
 * corrupt before it will report anything; and patched rather than genuinely
 * encoded, because asking sharp for a real 400 MP PNG would do to this suite
 * exactly what the guard exists to prevent in production.
 */
async function pngClaiming(width: number, height: number): Promise<Buffer> {
  const real = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#000' },
  })
    .png()
    .toBuffer();

  // 8-byte signature, then the IHDR chunk: 4 length, 4 type, 13 data, 4 CRC.
  const IHDR_TYPE_AT = 12;
  const IHDR_DATA_AT = 16;

  const patched = Buffer.from(real);
  patched.writeUInt32BE(width, IHDR_DATA_AT);
  patched.writeUInt32BE(height, IHDR_DATA_AT + 4);
  patched.writeUInt32BE(
    crc32(patched.subarray(IHDR_TYPE_AT, IHDR_DATA_AT + 13)),
    IHDR_DATA_AT + 13,
  );

  return patched;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const saturationOf = async (bytes: Buffer): Promise<number> => {
  const { channels } = await sharp(bytes).stats();
  const [r, g, b] = channels.map((channel) => channel.mean);
  return Math.max(r, g, b) - Math.min(r, g, b);
};

describe('ImageProcessor', () => {
  const processor = new ImageProcessor();

  describe('the stored derivative', () => {
    it('produces webp, because that is what item.photoUrl promises', async () => {
      const result = await processor.normalise(await swatch());
      const meta = await sharp(result.bytes).metadata();

      expect(meta.format).toBe('webp');
    });

    it('fits every source to the one card size', async () => {
      const result = await processor.normalise(await swatch(900, 506));
      const meta = await sharp(result.bytes).metadata();

      expect([meta.width, meta.height]).toEqual([CARD_WIDTH, CARD_HEIGHT]);
    });

    /** The derivative changes framing, never the colour treatment. */
    it('leaves the colours alone', async () => {
      const source = await swatch();
      const result = await processor.normalise(source);

      // Within a unit or two, not exact: the WebP encoder is lossy and rounds a
      // flat swatch by a shade. The old treatment took this to roughly half.
      const before = await saturationOf(source);
      expect(await saturationOf(result.bytes)).toBeGreaterThan(before - 2);
    });

    it('strips metadata, so a listing photo cannot carry EXIF into the game', async () => {
      const withExif = await sharp(await swatch())
        .withExif({ IFD0: { Copyright: 'Someone Else', Artist: 'A Person' } })
        .jpeg()
        .toBuffer();

      const result = await processor.normalise(withExif);
      const meta = await sharp(result.bytes).metadata();

      expect(meta.exif).toBeUndefined();
    });

    /**
     * The orientation tag does not survive the strip, so the rotation it
     * described has to be baked into the pixels — otherwise stripping EXIF
     * would itself turn the picture on its side.
     */
    it('applies the EXIF rotation it is about to discard', async () => {
      const quarterTurned = await sharp({
        create: {
          width: CARD_HEIGHT,
          height: CARD_WIDTH,
          channels: 3,
          background: '#c04028',
        },
      })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer();

      const result = await processor.normalise(quarterTurned);
      const meta = await sharp(result.bytes).metadata();

      expect([meta.width, meta.height]).toEqual([CARD_WIDTH, CARD_HEIGHT]);
    });

    it('names each derivative by the sha256 of its own bytes', async () => {
      const result = await processor.normalise(await swatch());

      expect(result.digest).toBe(digestOf(result.bytes));
    });
  });

  describe('rejections', () => {
    it('refuses bytes that are not an image', async () => {
      await expect(
        processor.normalise(Buffer.from('this is not a photograph')),
      ).rejects.toMatchObject({ reason: 'decode-failed' });
    });

    it.each([
      ['too small', 500, 610],
      ['right pixels, wrong shape', 1080, 1080],
      ['off by a row', CARD_WIDTH, CARD_HEIGHT - 1],
    ])('normalises a %s source', async (_label, width, height) => {
      const result = await processor.normalise(await swatch(width, height));
      const metadata = await sharp(result.bytes).metadata();

      expect([metadata.width, metadata.height]).toEqual([
        CARD_WIDTH,
        CARD_HEIGHT,
      ]);
    });

    it('refuses a source above the decode ceiling', async () => {
      const side = Math.floor(Math.sqrt(MAX_SOURCE_PIXELS)) + 1;
      await expect(
        processor.normalise(await pngClaiming(side, side)),
      ).rejects.toMatchObject({
        reason: 'too-large',
      });
    });

    it('refuses an animation rather than silently keeping frame one', async () => {
      // A real two-frame GIF. Synthesising one through sharp is fiddly enough
      // that the fixture would end up testing the encoder, not the guard.
      const twoFrames = Buffer.from(
        'R0lGODlhAQABAIAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQJAAAAACwAAAAA' +
          'AQABAAACAkQBACH5BAkAAAAALAAAAAABAAEAAAICRAEAOw==',
        'base64',
      );

      // Checked before the size gate, so a 1×1 animation is refused for being
      // animated rather than for being the wrong shape — which is the guard
      // under test.
      await expect(processor.normalise(twoFrames)).rejects.toMatchObject({
        reason: 'animated',
      });
    });

    /**
     * A 64x48 HEIC, straight out of the format an iPhone shoots in by default.
     *
     * The header parses — libvips reads the dimensions and the orientation
     * without complaint — and the decode is what fails, because the prebuilt
     * binary carries no HEVC decoder. That gap is the whole reason the guard
     * lives around the transform and not only around `metadata()`.
     */
    it('names HEIC when the header parses and the decode cannot', async () => {
      const heic = Buffer.from(
        'AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABhm1ldGEAAAAA' +
          'AAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJl' +
          'ZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAAjaWluZgAAAAAA' +
          'AQAAABVpbmZlAgAAAAABAABodmMxAAAAAOZpcHJwAAAAxWlwY28AAAATY29scm5j' +
          'bHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAAAAAAQAAAADAAAAAJaXJv' +
          'dAAAAAAQcGl4aQAAAAADCAgIAAAAcWh2Y0MBA3AAAACwAAAAAAAe8AD8/fj4AAAL' +
          'A6AAAQAXQAEMAf//A3AAAAMAsAAAAwAAAwAecCShAAEAI0IBAQNwAAADALAAAAMA' +
          'AAMAHqAUIEHBjE4h7kWVTcCAgYAgogABAAlEAcBjiyERTZAAAAAZaXBtYQAAAAAA' +
          'AAABAAEGgQIDBYaEAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAAboAAAAlAAAAAW1k' +
          'YXQAAAAAAAAANQAAACEoAa+izvA6v/q2FgYTZiecoNC8WduxZN6Ak7OAFV2LmeA=',
        'base64',
      );

      await expect(processor.normalise(heic)).rejects.toMatchObject({
        reason: 'unsupported-format',
        message: expect.stringContaining('HEIC'),
      });
    });

    /**
     * A JPEG cut off part-way through its scan data — an upload that dropped, or
     * a half-written file. Its SOF marker is intact, so it survives the header
     * probe and dies in the decoder, where an unguarded error would surface as a
     * 500 on a file the operator could simply re-save.
     */
    it('refuses a truncated source rather than letting sharp escape', async () => {
      const whole = await sharp({
        create: {
          width: 1200,
          height: 900,
          channels: 3,
          background: { r: 120, g: 40, b: 200 },
        },
      })
        .jpeg()
        .toBuffer();

      await expect(
        processor.normalise(whole.subarray(0, Math.floor(whole.length / 3))),
      ).rejects.toMatchObject({ reason: 'decode-failed' });
    });

    /**
     * 20 000 × 20 000 = 400 MP in a 70-byte file. Decoding it would reserve over
     * a gigabyte of native memory outside the V8 heap, where the heap cap cannot
     * see it and only the cgroup OOM killer can stop it.
     *
     * The header is probed before decoding and compared with the explicit source
     * ceiling, so the tiny payload is rejected without reserving its fake canvas.
     */
    it('refuses a decompression bomb on its declared size, before decoding', async () => {
      const bomb = await pngClaiming(20_000, 20_000);

      await expect(processor.normalise(bomb)).rejects.toMatchObject({
        reason: 'too-large',
      });
    });
  });
});
