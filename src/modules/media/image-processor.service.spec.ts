import 'reflect-metadata';

import sharp from 'sharp';

import {
  digestOf,
  ImageProcessor,
  phashDistance,
} from './image-processor.service';

/**
 * sharp runs for real here rather than behind a mock. It is fast enough on an
 * 800×800 image, and the guarantees worth asserting — that colour actually
 * comes out desaturated, that EXIF is actually gone — are exactly the ones a
 * mock would assert into existence without testing.
 */
const swatch = (
  width = 800,
  height = 800,
  rgb: { r: number; g: number; b: number } = { r: 200, g: 60, b: 40 },
): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: rgb } })
    .png()
    .toBuffer();

/** A photo-like image, so the perceptual hash has structure to describe. */
const scene = async (width = 800, height = 800): Promise<Buffer> => {
  const noise = Buffer.alloc(width * height * 3);
  for (let i = 0; i < noise.length; i += 3) {
    const x = (i / 3) % width;
    const y = Math.floor(i / 3 / width);
    noise[i] = (x * 255) / width;
    noise[i + 1] = (y * 255) / height;
    noise[i + 2] = ((x + y) * 255) / (width + height);
  }
  return sharp(noise, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
};

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

describe('ImageProcessor', () => {
  const processor = new ImageProcessor();

  describe('the washed derivative', () => {
    it('produces webp, because that is what item.photoUrl promises', async () => {
      const result = await processor.wash(await swatch());
      const meta = await sharp(result.bytes).metadata();

      expect(meta.format).toBe('webp');
    });

    it('desaturates, which is the whole point of the treatment', async () => {
      const source = await swatch();
      const result = await processor.wash(source);

      const saturationOf = async (bytes: Buffer) => {
        const { channels } = await sharp(bytes).stats();
        const [r, g, b] = channels.map((channel) => channel.mean);
        return Math.max(r, g, b) - Math.min(r, g, b);
      };

      expect(await saturationOf(result.bytes)).toBeLessThan(
        await saturationOf(source),
      );
    });

    it('caps the width so a 4000px source is not served to a phone', async () => {
      const result = await processor.wash(await swatch(4000, 3000));

      expect(result.width).toBe(1080);
      expect(result.height).toBe(864);
    });

    it('does not upscale a source smaller than the cap', async () => {
      // Upscaling produces a blurrier picture in a larger file — strictly worse
      // on both axes that matter.
      const result = await processor.wash(await swatch(700, 700));

      expect(result.width).toBe(700);
    });

    /**
     * The card is a fixed shape and `ItemPhoto` fills it with `cover`, so
     * something crops either way. Doing it here rather than on the client is
     * only worth it if it is *reliable* — and the obvious spelling of it is
     * not: sharp's `withoutEnlargement` silently declines to crop a source
     * smaller than the target box, which is most of this catalogue.
     */
    it.each([
      ['landscape', 2000, 1500],
      ['portrait', 500, 610],
      ['letterbox', 900, 520],
      ['square', 480, 480],
      ['smaller than the card box', 700, 700],
    ])('crops a %s source to 5:4', async (_label, width, height) => {
      const result = await processor.wash(await scene(width, height));
      const thumb = await sharp(result.thumbBytes).metadata();

      expect(result.width / result.height).toBeCloseTo(1.25, 2);
      expect((thumb.width ?? 0) / (thumb.height ?? 1)).toBeCloseTo(1.25, 2);
    });

    it('never enlarges a source to reach that shape', async () => {
      const result = await processor.wash(await scene(500, 610));

      // 500×610 can yield at most a 500×400 landscape crop. Anything wider
      // would be upscaled pixels padding out the ratio.
      expect(result.width).toBeLessThanOrEqual(500);
      expect(result.height).toBeLessThanOrEqual(610);
    });

    it('strips metadata, so a listing photo cannot carry EXIF into the game', async () => {
      const withExif = await sharp(await swatch())
        .withExif({ IFD0: { Copyright: 'Someone Else', Artist: 'A Person' } })
        .jpeg()
        .toBuffer();

      const result = await processor.wash(withExif);
      const meta = await sharp(result.bytes).metadata();

      expect(meta.exif).toBeUndefined();
    });

    it('emits a thumbnail for the review queue alongside the full derivative', async () => {
      const result = await processor.wash(await swatch());
      const thumb = await sharp(result.thumbBytes).metadata();

      expect(Math.max(thumb.width ?? 0, thumb.height ?? 0)).toBe(320);
      expect(result.thumbDigest).not.toBe(result.digest);
    });

    it('names each derivative by the sha256 of its own bytes', async () => {
      const result = await processor.wash(await swatch());

      expect(result.digest).toBe(digestOf(result.bytes));
      expect(result.thumbDigest).toBe(digestOf(result.thumbBytes));
    });
  });

  describe('rejections', () => {
    it('refuses bytes that are not an image', async () => {
      await expect(
        processor.wash(Buffer.from('this is not a photograph')),
      ).rejects.toMatchObject({ reason: 'decode-failed' });
    });

    it('refuses an image too small to recognise an object in', async () => {
      // 270×270 crops to a 270×216 card — a thumbnail by any reading.
      await expect(
        processor.wash(await swatch(270, 270)),
      ).rejects.toMatchObject({ reason: 'too-small' });
    });

    /**
     * The floor is on the card, not the source, and these two are why.
     *
     * Both produce a card a player cannot tell apart — 500×400 and 480×384 —
     * but a floor on the source's *shorter* edge passed the first and refused
     * the second, because one photographer shot portrait and the other
     * landscape. Since every derivative is cropped to 5:4 now, the shorter edge
     * is no longer a proxy for anything the player sees.
     */
    it('judges a source by the card it makes, not by its shorter edge', async () => {
      const portrait = await processor.wash(await scene(500, 610));
      expect([portrait.width, portrait.height]).toEqual([500, 400]);

      const landscape = await processor.wash(await scene(480, 400));
      expect([landscape.width, landscape.height]).toEqual([480, 384]);
    });

    it('accepts ordinary product shots that are wide or tall', async () => {
      await expect(
        processor.wash(await swatch(900, 506)),
      ).resolves.toBeTruthy();
      await expect(
        processor.wash(await swatch(500, 610)),
      ).resolves.toBeTruthy();
      // The shortest real photograph in the first catalogue import.
      await expect(
        processor.wash(await swatch(897, 473)),
      ).resolves.toBeTruthy();
      // A letterbox boat shot: 434 on the short side, but a 543×434 card.
      await expect(
        processor.wash(await swatch(800, 434)),
      ).resolves.toBeTruthy();
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
      // animated rather than for being small — which is the guard under test.
      await expect(processor.wash(twoFrames)).rejects.toMatchObject({
        reason: 'animated',
      });
    });

    it('refuses a decompression bomb on its declared size, before decoding', async () => {
      // 20 000 × 20 000 = 400 MP in a 70-byte file. Decoding it would reserve
      // over a gigabyte of native memory outside the V8 heap, where the heap
      // cap cannot see it and only the cgroup OOM killer can stop it.
      const bomb = await pngClaiming(20_000, 20_000);

      await expect(processor.wash(bomb)).rejects.toMatchObject({
        reason: 'too-large',
      });
    });
  });

  describe('the perceptual hash', () => {
    it('survives rescaling and recompression, which is the case it exists for', async () => {
      const original = await scene(800, 800);
      const republished = await sharp(original)
        .resize(520, 520)
        .jpeg({ quality: 70 })
        .toBuffer();

      const a = await processor.wash(original);
      const b = await processor.wash(
        await sharp(republished).resize(800, 800).png().toBuffer(),
      );

      expect(phashDistance(a.phash, b.phash)).toBeLessThanOrEqual(6);
    });

    it('separates genuinely different pictures', async () => {
      const a = await processor.wash(await scene(800, 800));
      const b = await processor.wash(
        await sharp(await scene(800, 800))
          .flop()
          .toBuffer(),
      );

      expect(phashDistance(a.phash, b.phash)).toBeGreaterThan(6);
    });

    it('is 64 bits, written as 16 hex characters', async () => {
      const { phash } = await processor.wash(await scene());

      expect(phash).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe('phashDistance', () => {
    it('counts differing bits, not differing characters', () => {
      expect(phashDistance('0000000000000000', '0000000000000001')).toBe(1);
      expect(phashDistance('0000000000000000', '000000000000000f')).toBe(4);
      expect(phashDistance('ffffffffffffffff', '0000000000000000')).toBe(64);
    });

    it('refuses to compare hashes of different lengths', () => {
      expect(() => phashDistance('abcd', 'abcdef')).toThrow();
    });
  });
});
