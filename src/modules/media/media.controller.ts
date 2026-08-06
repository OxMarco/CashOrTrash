import {
  Controller,
  Get,
  NotFoundException,
  Param,
  PipeTransform,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FastifyReply } from 'fastify';

import { Public } from 'src/common/decorators/public.decorator';
import { DIGEST_PATTERN, MediaStore } from './media-store';

/** A year. Safe to the point of being uninteresting: the URL *is* the content. */
const MAX_AGE_SECONDS = 31_536_000;

const FILENAME_PATTERN = /^([0-9a-f]{64})\.webp$/;

/**
 * Accepts only `<64 hex>.webp` and hands back the bare digest.
 *
 * This is the whole of the path-traversal defence, and it is deliberately a
 * whitelist of one shape rather than a blacklist of dangerous ones. Everything
 * downstream builds its filesystem path from slices of the hex this returns, so
 * there is no input string that can escape the media root — traversal is
 * impossible by construction rather than by configuration.
 *
 * `@fastify/static` is deliberately not used here. Declining a well-tested
 * library is only defensible if the replacement is stronger, which is why the
 * pattern is this narrow and why `media.e2e-spec.ts` proves the traversal cases
 * rather than asserting them in a comment.
 */
export class MediaDigestPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const match = FILENAME_PATTERN.exec(value);
    // A 404 rather than a 400: a malformed name and an unknown one are the same
    // answer to anyone outside, and distinguishing them only tells a prober
    // that their syntax was interesting.
    if (!match) throw new NotFoundException();
    return match[1];
  }
}

/**
 * Serves washed item derivatives.
 *
 * Public by necessity — these are the photographs in the game, requested by an
 * `<Image>` in the mobile client before any auth header exists on the request.
 * Nothing here is secret: the price is the secret, and it never touches this
 * module.
 */
@ApiExcludeController()
@Public()
@Controller('media')
export class MediaController {
  constructor(private readonly store: MediaStore) {}

  @Get('items/:digest')
  // A gameplay screen loads five photographs and a summary screen five more, so
  // the global gameplay budget is the wrong shape here. Generous, because the
  // cost of a hit is a static file read and a 429 is a broken-looking game.
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async item(
    @Param('digest', MediaDigestPipe) digest: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const object = await this.store.open(digest);
    if (!object) throw new NotFoundException();

    void reply
      .header('Content-Type', 'image/webp')
      .header('Content-Length', object.bytes)
      .header('Cache-Control', `public, max-age=${MAX_AGE_SECONDS}, immutable`)
      // The digest, quoted. Not a weak validator: identical bytes are the only
      // way to arrive at the same entity tag.
      .header('ETag', `"${digest}"`)
      // These bytes are attacker-influenced (a fetched photograph re-encoded).
      // webp is not a sniffable script vector, but the header costs nothing and
      // the alternative is reasoning about it again on every future change.
      .header('X-Content-Type-Options', 'nosniff')
      .send(object.stream);
  }
}

/** Re-exported so callers building a stored URL do not hand-assemble one. */
export function mediaUrlFor(digest: string, publicBase?: string): string {
  if (!DIGEST_PATTERN.test(digest)) throw new Error(`Not a digest: ${digest}`);
  return `${publicBase ?? ''}/media/items/${digest}.webp`;
}
