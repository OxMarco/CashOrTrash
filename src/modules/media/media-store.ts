import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { MediaConfig } from 'src/config/configuration';

/** A sha256 hex digest — the whole of a stored object's identity. */
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Where a digest lives on disk, relative to the store root.
 *
 * Two levels of hex-prefix fan-out rather than one flat directory: at a few
 * thousand items a flat directory is merely untidy, but the catalogue is meant
 * to grow and `readdir` on a hundred-thousand-entry directory is a problem
 * nobody wants to discover during a GC sweep.
 *
 * Callers must pass a digest already matched against `DIGEST_PATTERN`. Because
 * every path segment is then a slice of validated hex, no input can traverse
 * out of the root — the guarantee is structural, not a matter of sanitising.
 */
export function relativePathFor(digest: string): string {
  return join(
    'items',
    digest.slice(0, 2),
    digest.slice(2, 4),
    `${digest}.webp`,
  );
}

export interface StoredObject {
  stream: Readable;
  bytes: number;
}

/**
 * Content-addressed blob storage for item photography.
 *
 * Abstract because the local implementation pins the app to a single host: the
 * bytes live on a volume only one container mounts read-write. Swapping in an
 * object-store implementation is a one-line binding change in `MediaModule` and
 * nothing else moves — the same seam `PushSender` uses for the same reason.
 */
export abstract class MediaStore {
  /** Idempotent: the digest *is* the content, so a rewrite is a no-op. */
  abstract put(digest: string, bytes: Buffer): Promise<void>;
  abstract open(digest: string): Promise<StoredObject | null>;
  abstract has(digest: string): Promise<boolean>;
  abstract delete(digest: string): Promise<void>;
  /** Every digest held, for the orphan sweep. */
  abstract list(): AsyncIterable<string>;
}

@Injectable()
export class LocalMediaStore extends MediaStore {
  private readonly logger = new Logger(LocalMediaStore.name);
  private readonly root: string;

  constructor(config: ConfigService) {
    super();
    this.root = config.getOrThrow<MediaConfig>('media').root;
  }

  async put(digest: string, bytes: Buffer): Promise<void> {
    const path = this.pathFor(digest);
    await mkdir(join(path, '..'), { recursive: true });

    // Written unconditionally rather than after a `has` check: the digest is
    // the content, so a concurrent writer producing the same path is producing
    // the same bytes, and the race is therefore not one worth avoiding.
    await writeFile(path, bytes);
  }

  async open(digest: string): Promise<StoredObject | null> {
    const path = this.pathFor(digest);

    try {
      const info = await stat(path);
      return { stream: createReadStream(path), bytes: info.size };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async has(digest: string): Promise<boolean> {
    try {
      await stat(this.pathFor(digest));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async delete(digest: string): Promise<void> {
    await rm(this.pathFor(digest), { force: true });
  }

  async *list(): AsyncIterable<string> {
    const root = join(this.root, 'items');

    let entries: string[];
    try {
      entries = await readdir(root, { recursive: true });
    } catch (error) {
      // An empty store is a store with nothing in it, not an error. This is the
      // normal state of a fresh deployment.
      if (isMissing(error)) return;
      throw error;
    }

    for (const entry of entries) {
      const name = entry.split(/[\\/]/).at(-1) ?? '';
      if (!name.endsWith('.webp')) continue;

      const digest = name.slice(0, -'.webp'.length);
      if (DIGEST_PATTERN.test(digest)) {
        yield digest;
        continue;
      }

      // Not fatal: a stray file cannot be served (the route only accepts a
      // digest) and deleting it would be a sweep doing more than it was asked.
      this.logger.warn(`Ignoring non-digest file in media store: ${entry}`);
    }
  }

  private pathFor(digest: string): string {
    if (!DIGEST_PATTERN.test(digest)) {
      // Belt and braces. Every caller validates first, and this is what makes
      // "no input reaches the filesystem unvalidated" true rather than assumed.
      throw new Error(`Not a digest: ${digest}`);
    }
    return join(this.root, relativePathFor(digest));
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
