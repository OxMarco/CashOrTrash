import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import fastifyHelmet from '@fastify/helmet';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { readFile } from 'node:fs/promises';

import { UNPREFIXED_ROUTES } from 'src/app.bootstrap';
import { LandingController, LANDING_ASSET_PATHS } from './landing.controller';
import { appConfig, legalConfig, linksConfig } from 'src/config/configuration';

/**
 * The landing page is the one HTML document this server renders, and every
 * mechanism it depends on fails *silently*: a global prefix that swallows `/`
 * serves the page at `/v1` and nobody notices until the domain is live; a CSP
 * that helmet wins serves a blank page with a console full of blocked inline
 * styles; a path that does not resolve serves a 404 from an otherwise healthy
 * API. None of the three shows up in a typecheck.
 *
 * Booted as a real Fastify app with the same prefix exclusion and the same
 * helmet registration `configureApp` performs, because the interaction between
 * those two and the controller is the whole of what is being asserted. No
 * database: this module has no dependencies beyond the file on disk.
 */
describe('the landing page', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ load: [appConfig, legalConfig, linksConfig] }),
      ],
      controllers: [LandingController],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('v1', { exclude: UNPREFIXED_ROUTES });
    await app.register(fastifyHelmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          scriptSrc: ["'none'"],
          styleSrc: ["'none'"],
        },
      },
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('is served at the root, outside the versioned API', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<html');
  });

  it('is not reachable under the API prefix', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1' });

    expect(response.statusCode).toBe(404);
  });

  it.each(['/privacy', '/support', '/terms'])(
    'serves the public legal surface at %s',
    async (url) => {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('CashOrTrash');
    },
  );

  // The store listing's support link points here. It 404'd through two review
  // cycles, so the alias is pinned rather than left to be re-derived.
  it("redirects the store listing's /tos link to the terms", async () => {
    const response = await app.inject({ method: 'GET', url: '/tos' });

    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe('/terms');
  });

  it('serves the invite fallback outside v1', async () => {
    const match = await app.inject({ method: 'GET', url: '/match/K7PXQ2' });
    expect(match.statusCode).toBe(200);
    expect(match.body).toContain('cashortrash://match/K7PXQ2');
  });

  // Until the app is in the stores there is nothing to associate with. A
  // placeholder file would be worse than none: both platforms cache a bad
  // association and keep opening the browser after the real one lands.
  it('withholds the association files while no app identity is configured', async () => {
    const [apple, android] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/.well-known/apple-app-site-association',
      }),
      app.inject({ method: 'GET', url: '/.well-known/assetlinks.json' }),
    ]);
    expect(apple.statusCode).toBe(404);
    expect(android.statusCode).toBe(404);
  });

  /**
   * The page inlines its styles, scripts and fonts, so the global deny-all
   * policy would render it blank. Asserted as an override rather than an
   * exception in `HELMET_OPTIONS`: helmet sets its header first and this route
   * replaces it, which is what keeps the loosened policy off every other
   * response.
   */
  it('replaces the deny-all policy with one that allows its own inlined assets', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    const policy = response.headers['content-security-policy'];

    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("style-src 'unsafe-inline'");
    expect(policy).toContain("script-src 'unsafe-inline'");
    expect(policy).toContain('font-src data:');
    // The loosening stops at what the page actually needs.
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toContain("script-src 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  /** 350 KB of inlined page: an ETag nobody evaluates is decoration. */
  it('answers a matching If-None-Match with 304 and no body', async () => {
    const first = await app.inject({ method: 'GET', url: '/' });
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const second = await app.inject({
      method: 'GET',
      url: '/',
      headers: { 'if-none-match': etag },
    });

    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
    expect(second.headers.etag).toBe(etag);
  });

  /**
   * The bug this guards against had no symptom on a first visit and no trace in
   * the server logs: a 304's headers are merged into the stored response under
   * RFC 9111, so a revalidation that omitted the override let helmet's deny-all
   * policy overwrite the cached one. Every visit after the first rendered a
   * blank page with a console full of blocked inline style and script.
   */
  it('repeats the policy on the 304, so a revalidation cannot overwrite it', async () => {
    const first = await app.inject({ method: 'GET', url: '/' });
    const revalidated = await app.inject({
      method: 'GET',
      url: '/',
      headers: { 'if-none-match': first.headers.etag as string },
    });

    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.headers['content-security-policy']).toBe(
      first.headers['content-security-policy'],
    );
    expect(revalidated.headers['content-security-policy']).toContain(
      "style-src 'unsafe-inline'",
    );
  });

  it('does not answer a stale If-None-Match with 304', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: { 'if-none-match': '"not-the-current-digest"' },
    });

    expect(response.statusCode).toBe(200);
  });

  /**
   * The two candidates exist because `nest build` puts the output at
   * `dist/modules` in the image and `dist/src/modules` locally, so the asset is
   * three levels up in one layout and four in the other. Whichever this test
   * runs under, exactly one of them has to resolve — and the first that does is
   * the one the controller serves.
   */
  it('finds its asset under the build layout it is running in', async () => {
    const found = await Promise.all(
      LANDING_ASSET_PATHS.map((path) =>
        readFile(path).then(
          () => true,
          () => false,
        ),
      ),
    );

    expect(found).toContain(true);
  });
});

/**
 * The social card is the entire conversion surface of the share loop: the grid
 * a player posts is spoiler-free by design, which also makes it meaningless to
 * anyone who has not played. Everything that explains what was posted lives in
 * these tags, and all of it fails silently — a relative `og:image`, a prefixed
 * route, a missing origin all unfurl as a bare link with nothing in the logs.
 */
describe('the association files, once the app exists', () => {
  const FINGERPRINT =
    'AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA';
  let app: NestFastifyApplication;
  const previous: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [key, value] of Object.entries({
      APPLE_APP_ID: 'ABCDE12345.fun.cashortrash.app',
      ANDROID_SHA256_CERT_FINGERPRINT: FINGERPRINT,
    })) {
      previous[key] = process.env[key];
      process.env[key] = value;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [appConfig, legalConfig, linksConfig],
          ignoreEnvFile: true,
        }),
      ],
      controllers: [LandingController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('v1', { exclude: UNPREFIXED_ROUTES });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('serves both files outside v1 with the configured identity', async () => {
    const [apple, android] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/.well-known/apple-app-site-association',
      }),
      app.inject({ method: 'GET', url: '/.well-known/assetlinks.json' }),
    ]);
    expect(apple.statusCode).toBe(200);
    expect(apple.json()).toMatchObject({
      applinks: {
        details: [
          { appID: 'ABCDE12345.fun.cashortrash.app', paths: ['/match/*'] },
        ],
      },
    });
    expect(android.statusCode).toBe(200);
    expect(android.json()[0].target).toMatchObject({
      package_name: 'fun.cashortrash.app',
      sha256_cert_fingerprints: [FINGERPRINT],
    });
  });
});

describe('the social card', () => {
  const ORIGIN = 'https://cashortrash.fun';

  async function boot(publicOrigin: string): Promise<NestFastifyApplication> {
    const previous = process.env.PUBLIC_ORIGIN;
    process.env.PUBLIC_ORIGIN = publicOrigin;
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            load: [appConfig, legalConfig, linksConfig],
            ignoreEnvFile: true,
          }),
        ],
        controllers: [LandingController],
      }).compile();

      const booted = moduleRef.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
      );
      booted.setGlobalPrefix('v1', { exclude: UNPREFIXED_ROUTES });
      await booted.init();
      await booted.getHttpAdapter().getInstance().ready();
      return booted;
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_ORIGIN;
      else process.env.PUBLIC_ORIGIN = previous;
    }
  }

  describe('with a public origin', () => {
    let app: NestFastifyApplication;

    beforeAll(async () => {
      app = await boot(ORIGIN);
    });

    afterAll(async () => {
      await app.close();
    });

    it('names the card in absolute terms, which is the only kind a crawler reads', async () => {
      const response = await app.inject({ method: 'GET', url: '/' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(
        `<meta property="og:image" content="${ORIGIN}/og-card.png" />`,
      );
      expect(response.body).toContain(
        `<meta property="og:url" content="${ORIGIN}" />`,
      );
      expect(response.body).toContain(
        '<meta name="twitter:card" content="summary_large_image" />',
      );
    });

    it('says what the game is, since five squares and a number do not', async () => {
      const response = await app.inject({ method: 'GET', url: '/' });

      expect(response.body).toContain('<meta property="og:title"');
      expect(response.body).toContain('Bet a price range, not a number');
    });

    // The og:image URL is built off the bare origin. If the global prefix ever
    // swallows this route the tags stay valid and every crawler still 404s.
    it('serves the card at the unprefixed path the tags point at', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/og-card.png',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.rawPayload.subarray(1, 4).toString('latin1')).toBe('PNG');
    });

    it('revalidates the card rather than resending it', async () => {
      const first = await app.inject({ method: 'GET', url: '/og-card.png' });
      const etag = first.headers.etag as string;

      const second = await app.inject({
        method: 'GET',
        url: '/og-card.png',
        headers: { 'if-none-match': etag },
      });

      expect(second.statusCode).toBe(304);
    });
  });

  describe('without a public origin', () => {
    let app: NestFastifyApplication;

    beforeAll(async () => {
      app = await boot('');
    });

    afterAll(async () => {
      await app.close();
    });

    it('drops the image rather than emitting a path no crawler resolves', async () => {
      const response = await app.inject({ method: 'GET', url: '/' });

      expect(response.body).not.toContain('og:image');
      expect(response.body).not.toContain('og:url');
    });

    it('still says what the game is, because a plain card beats a broken one', async () => {
      const response = await app.inject({ method: 'GET', url: '/' });

      expect(response.body).toContain('<meta property="og:title"');
      expect(response.body).toContain('<meta name="description"');
    });
  });
});
