import { PLACEHOLDER_DIGEST } from '../../src/modules/media/placeholder';
import { createTestApp, TestApp } from '../support/test-app';

/**
 * `MediaController` declines `@fastify/static`, a call that is only defensible
 * if what replaces it is stronger.
 *
 * The claim is that traversal is impossible *by construction*: the route accepts
 * `<64 hex>.webp` and nothing else, and every filesystem path segment is then a
 * slice of that validated hex. A claim like that is worth exactly as much as the
 * test that exercises it, which is why these cases are here rather than in a
 * comment.
 */
describe('media serving', () => {
  let ctx: TestApp;
  let url: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    url = `${ctx.baseUrl}/media/items`;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  describe('serving a stored derivative', () => {
    it('serves the placeholder every seeded item points at', async () => {
      // The seeded catalogue's photoUrl is this exact path. If it 404s, all 26
      // items render a broken image — which is the state this phase exists to
      // get out of.
      const response = await fetch(`${url}/${PLACEHOLDER_DIGEST}.webp`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/webp');
      expect(Number(response.headers.get('content-length'))).toBeGreaterThan(0);
    });

    it('is cacheable forever, because the URL is the content', async () => {
      const response = await fetch(`${url}/${PLACEHOLDER_DIGEST}.webp`);

      expect(response.headers.get('cache-control')).toContain('immutable');
      expect(response.headers.get('etag')).toBe(`"${PLACEHOLDER_DIGEST}"`);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('actually returns webp bytes, not an error page with the right header', async () => {
      const response = await fetch(`${url}/${PLACEHOLDER_DIGEST}.webp`);
      const bytes = Buffer.from(await response.arrayBuffer());

      // RIFF....WEBP
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
    });

    it('answers a digest nothing is stored under with a 404', async () => {
      const absent = 'a'.repeat(64);
      const response = await fetch(`${url}/${absent}.webp`);

      expect(response.status).toBe(404);
    });
  });

  describe('path traversal', () => {
    // Encoded and unencoded, because Fastify decodes the path before routing
    // and a defence that only survives one of those is not a defence.
    const traversals = [
      '../../../etc/passwd',
      '..%2f..%2f..%2fetc%2fpasswd',
      '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '....//....//etc/passwd',
      `${PLACEHOLDER_DIGEST}.webp/../../../../etc/passwd`,
      `..%00${PLACEHOLDER_DIGEST}.webp`,
    ];

    it.each(traversals)('refuses %s', async (attempt) => {
      const response = await fetch(`${url}/${attempt}`);

      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).not.toContain('root:');
    });
  });

  describe('the digest whitelist', () => {
    const malformed: Array<[string, string]> = [
      ['a digest one character short', `${'a'.repeat(63)}.webp`],
      ['a digest one character long', `${'a'.repeat(65)}.webp`],
      // Uppercase is a different string that would hash-address the same file
      // on a case-insensitive filesystem and a different one on ext4. Refusing
      // it keeps the URL canonical.
      ['an uppercase digest', `${PLACEHOLDER_DIGEST.toUpperCase()}.webp`],
      ['non-hex characters', `${'g'.repeat(64)}.webp`],
      ['a digest with no extension', PLACEHOLDER_DIGEST],
      ['a different extension', `${PLACEHOLDER_DIGEST}.png`],
      ['a double extension', `${PLACEHOLDER_DIGEST}.webp.php`],
      ['an empty name', '.webp'],
    ];

    it.each(malformed)('refuses %s', async (_label, name) => {
      const response = await fetch(`${url}/${name}`);

      expect(response.status).toBe(404);
    });
  });

  it('sits outside the versioned API, so a version bump cannot break stored URLs', async () => {
    // `item.photoUrl` holds these paths in the database. If they carried the
    // API prefix, bumping to /v2 would invalidate every row.
    const prefixed = await fetch(
      `${ctx.baseUrl}/v1/media/items/${PLACEHOLDER_DIGEST}.webp`,
    );

    expect(prefixed.status).toBe(404);
  });
});
