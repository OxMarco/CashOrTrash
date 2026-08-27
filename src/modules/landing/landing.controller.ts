import {
  Controller,
  Get,
  Logger,
  NotFoundException,
  Req,
  Res,
  Param,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';

import { Public } from 'src/common/decorators/public.decorator';
import { AppConfig, LegalConfig, LinksConfig } from 'src/config/configuration';

/**
 * Two candidates, and which one resolves depends on whether this file is
 * running from source or from the build.
 *
 * `tsconfig.build.json` pins `rootDir` to the package root, so every build —
 * the Docker image included — lands the output at `dist/src/…`; the older
 * `dist/modules/…` shape the two paths were originally written for no longer
 * happens anywhere. What is left is still a real two-way split: under jest and
 * ts-node `__dirname` is `src/modules/landing`, three levels below the repository
 * root, while under `node dist/src/main.js` it is `dist/src/modules/landing`, four.
 * Tried in order, so the source layout wins where both could exist.
 */
export const LANDING_ASSET_PATHS = [
  join(__dirname, '..', '..', '..', 'assets', 'landing.html'),
  join(__dirname, '..', '..', '..', '..', 'assets', 'landing.html'),
];

/** Same two-candidate dance as the landing page, for the unfurl image. */
export const OG_CARD_PATHS = [
  join(__dirname, '..', '..', '..', 'assets', 'og-card.png'),
  join(__dirname, '..', '..', '..', '..', 'assets', 'og-card.png'),
];

const OG_TITLE = 'CashOrTrash: guess what stuff costs';
const OG_DESCRIPTION =
  'Bet a price range, not a number. The narrower the range, the bigger the multiplier — miss it and score nothing. Five items a day, same five for everyone.';

/**
 * The policy for the landing document, and *only* the landing document: the
 * page is one self-contained file, so inline style, inline script and `data:`
 * fonts are the whole of it. Everything the page does not inline stays denied.
 *
 * A constant rather than an inline literal because it has to go out on the 304
 * as well as the 200. A 304 is not a response the browser throws away — under
 * RFC 9111 its headers are merged into the stored response, so a revalidation
 * that omits this header lets helmet's global deny-all overwrite the cached
 * policy. The page then renders blank on every visit after the first, with a
 * console full of blocked inline style and script and nothing in the server
 * logs to say why.
 */
const LANDING_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  'font-src data:',
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const escapeAttribute = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] as string,
  );

/**
 * The marketing page at `/` — the one HTML document this server renders.
 *
 * The page is a single self-contained file: styles, scripts, and fonts are all
 * inlined, so it makes no second request and needs no static-file middleware.
 * That self-containment is also why this route carries its own CSP instead of
 * the global deny-everything policy in `app.bootstrap.ts`: inline style and
 * script are the entire page, and `data:` fonts are how it ships the app's
 * typefaces. Everything not inlined stays denied.
 */
@ApiExcludeController()
@Public()
@Controller()
export class LandingController {
  private readonly logger = new Logger(LandingController.name);
  private page: { html: Buffer; etag: string } | null = null;
  private ogCardFile: { png: Buffer; etag: string } | null = null;

  constructor(private readonly config: ConfigService) {}

  @Get()
  async landing(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const page = await this.load();
    // A missing asset degrades to a 404 on the marketing page; it must not
    // take down an API process that is otherwise serving the game.
    if (!page) throw new NotFoundException();

    // Fastify sets ETags but does not evaluate them; without this branch the
    // header is decoration and every revalidation re-downloads 350 KB.
    if (request.headers['if-none-match'] === page.etag) {
      void reply
        .status(304)
        .header('ETag', page.etag)
        .header('Cache-Control', 'public, max-age=300')
        .header('Content-Security-Policy', LANDING_CSP)
        .send();
      return;
    }

    void reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Content-Length', page.html.byteLength)
      .header('Cache-Control', 'public, max-age=300')
      .header('ETag', page.etag)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', LANDING_CSP)
      .send(page.html);
  }

  @Get('privacy')
  privacy(@Res() reply: FastifyReply): void {
    const app = this.config.getOrThrow<AppConfig>('app');
    const email = this.config.getOrThrow<LegalConfig>('legal').supportEmail;
    this.sendDocument(
      reply,
      'Privacy policy',
      `
        <p>Last updated: 20 August 2026</p>
        <p>CashOrTrash creates an anonymous player account for each installation. We process a random device identifier, your chosen handle and avatar seed, scores, streaks, game sessions, match and friend relationships, and notification tokens only when you opt in to notifications.</p>
        <p>At registration we retain the originating IP address for up to ${app.registrationIpRetentionDays} days to prevent account farming and abuse. Server access and security logs may also contain IP addresses for a limited operational retention period.</p>
        <h2>Analytics and crash reports</h2>
        <p>Analytics and crash reporting are off by default. If you choose <strong>Share</strong>, the app sends anonymous product events to PostHog and crash diagnostics to Sentry. Session replay, advertising tracking, GeoIP enrichment, and user identification are disabled. You can withdraw this choice at any time in Profile.</p>
        <h2>Why we use the data</h2>
        <p>We use it to run the game, maintain leaderboards and matches, prevent abuse, deliver requested notifications, diagnose failures, and improve the product when you have consented to analytics.</p>
        <h2>Retention and deletion</h2>
        <p>Gameplay remains while your account exists. Deleting the account is self-service: open Profile, choose <strong>Delete account</strong>, and confirm. Deletion removes the handle, account credential, scores, games, friendships, matches, and notification tokens. Short-lived cache and backup copies expire under the service retention schedule and are not restored into the live service.</p>
        <h2>Your choices</h2>
        <p>You may disable analytics at any time in Profile, and delete the account yourself from the same screen. For access, correction, or privacy questions, email <a href="mailto:${email}">${email}</a>.</p>
      `,
    );
  }

  @Get('support')
  support(@Res() reply: FastifyReply): void {
    const email = this.config.getOrThrow<LegalConfig>('legal').supportEmail;
    this.sendDocument(
      reply,
      'Support',
      `<p>For gameplay, billing, safety, accessibility, or account help, email <a href="mailto:${email}">${email}</a>.</p>
       <p>Include the app version shown at the bottom of Profile and a description of what happened. Never send passwords or authentication tokens; CashOrTrash does not use passwords.</p>
       <p><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of service</a></p>`,
    );
  }

  @Get('terms')
  terms(@Res() reply: FastifyReply): void {
    const email = this.config.getOrThrow<LegalConfig>('legal').supportEmail;
    this.sendDocument(
      reply,
      'Terms of service',
      `
        <p>Last updated: 23 August 2026</p>
        <p>These terms govern your use of the CashOrTrash game and the service behind it. Using the app means you accept them.</p>
        <h2>The service</h2>
        <p>CashOrTrash is a guessing game: each day it shows the same five items to everyone and scores the price range you bet. It is entertainment. Prices, item descriptions, and other item copy are drawn from public listings and generated automatically, may be inaccurate or out of date, and are not an offer, a valuation, or advice of any kind. Nothing here can be bought or sold.</p>
        <h2>Your account</h2>
        <p>Installing the app creates an anonymous account tied to that installation. There is no password to recover: lose the installation and you lose access to the account, and we cannot restore or transfer one. You are responsible for what happens under your account, and your handle must not impersonate anyone or be abusive, hateful, or obscene.</p>
        <h2>Fair play</h2>
        <p>Play the game as it is presented. Do not automate play, script or replay requests against the API, tamper with the client, share or farm accounts to inflate a leaderboard, or attempt to reach another player's data. We may reset scores, remove a handle from the leaderboard, or close an account that does any of this.</p>
        <h2>Availability</h2>
        <p>The service is provided as it is, without warranty, and may change, break, or stop. Rounds, scores, and leaderboards can be corrected or reset when something goes wrong. To the extent the law allows, we are not liable for lost scores, streaks, or any indirect loss arising from your use of the game.</p>
        <h2>Ending it</h2>
        <p>You can delete your account yourself at any time: open Profile, choose <strong>Delete account</strong>, and confirm. Deletion is permanent and cannot be undone. We may suspend or close an account that breaks these terms.</p>
        <h2>Changes and contact</h2>
        <p>We may update these terms; continuing to play after a change means accepting the current version. Questions go to <a href="mailto:${email}">${email}</a>.</p>
      `,
    );
  }

  @Get('match/:inviteCode')
  matchFallback(
    @Param('inviteCode') inviteCode: string,
    @Res() reply: FastifyReply,
  ): void {
    if (!/^[A-Z2-9]{6,12}$/.test(inviteCode)) throw new NotFoundException();
    this.sendDocument(
      reply,
      'Open match invite',
      `<p>This invite opens in the CashOrTrash app.</p>
       <p><a href="cashortrash://match/${encodeURIComponent(inviteCode)}">Open CashOrTrash</a></p>
       <p>If the app is not installed yet, visit <a href="/support">Support</a> for launch and installation help.</p>`,
    );
  }

  /**
   * The unfurl image, served as a plain file.
   *
   * Cached hard: it is immutable for the life of a deployment, and a crawler
   * that refetches it on every share is the one client guaranteed to be slow
   * about it. Not under `.well-known`, so the global CSP applies — which is
   * correct for an image nothing embeds a script into.
   */
  @Get('og-card.png')
  async ogCard(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const card = await this.loadOgCard();
    if (!card) throw new NotFoundException();

    if (request.headers['if-none-match'] === card.etag) {
      void reply
        .status(304)
        .header('ETag', card.etag)
        .header('Cache-Control', 'public, max-age=86400')
        .send();
      return;
    }

    void reply
      .header('Content-Type', 'image/png')
      .header('Content-Length', card.png.byteLength)
      .header('Cache-Control', 'public, max-age=86400')
      .header('ETag', card.etag)
      .header('X-Content-Type-Options', 'nosniff')
      .send(card.png);
  }

  private async loadOgCard(): Promise<{ png: Buffer; etag: string } | null> {
    if (this.ogCardFile) return this.ogCardFile;
    for (const path of OG_CARD_PATHS) {
      let png: Buffer;
      try {
        png = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        throw error;
      }

      const etag = `"${createHash('sha256').update(png).digest('hex')}"`;
      this.ogCardFile = { png, etag };
      return this.ogCardFile;
    }
    this.logger.error(
      `Could not read assets/og-card.png from any of: ${OG_CARD_PATHS.join(', ')}`,
    );
    return null;
  }

  @Get('.well-known/apple-app-site-association')
  appleAssociation(@Res() reply: FastifyReply): void {
    const links = this.config.getOrThrow<LinksConfig>('links');
    if (!links.appleAppId) {
      void reply.code(404).send();
      return;
    }
    void reply
      .header('Content-Type', 'application/json')
      .header('Cache-Control', 'public, max-age=3600')
      .send({
        applinks: {
          apps: [],
          details: [{ appID: links.appleAppId, paths: ['/match/*'] }],
        },
      });
  }

  @Get('.well-known/assetlinks.json')
  androidAssociation(@Res() reply: FastifyReply): void {
    const links = this.config.getOrThrow<LinksConfig>('links');
    if (!links.androidSha256Fingerprint) {
      void reply.code(404).send();
      return;
    }
    void reply
      .header('Content-Type', 'application/json')
      .header('Cache-Control', 'public, max-age=3600')
      .send([
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: {
            namespace: 'android_app',
            package_name: links.androidPackage,
            sha256_cert_fingerprints: [links.androidSha256Fingerprint],
          },
        },
      ]);
  }

  /**
   * The card a shared result unfurls to.
   *
   * The grid a player posts is deliberately spoiler-free, which also makes it
   * meaningless to anyone who has not played: five squares and a number name no
   * game. Everything that explains what was posted — and everything that makes
   * it worth tapping — lives in these tags, so they are the whole conversion
   * surface of the share loop.
   *
   * Injected here rather than written into `assets/landing.html` for two
   * reasons: that file is a generated 350 KB export and hand-edits to it do not
   * survive the next one, and `og:url`/`og:image` have to be absolute, which
   * means they can only be built once the origin is known at runtime.
   *
   * Without an origin the image and canonical URL are dropped rather than
   * emitted as relative paths, which no crawler resolves. Title and description
   * still ship — a plain card beats a broken one.
   */
  private withSocialCard(html: string): string {
    const origin = this.config.getOrThrow<AppConfig>('app').publicOrigin;

    const tags = [
      `<meta name="description" content="${escapeAttribute(OG_DESCRIPTION)}" />`,
      '<meta property="og:type" content="website" />',
      '<meta property="og:site_name" content="CashOrTrash" />',
      `<meta property="og:title" content="${escapeAttribute(OG_TITLE)}" />`,
      `<meta property="og:description" content="${escapeAttribute(OG_DESCRIPTION)}" />`,
      ...(origin
        ? [
            `<meta property="og:url" content="${escapeAttribute(origin)}" />`,
            `<link rel="canonical" href="${escapeAttribute(origin)}" />`,
            `<meta property="og:image" content="${escapeAttribute(`${origin}/og-card.png`)}" />`,
            '<meta property="og:image:type" content="image/png" />',
            '<meta property="og:image:width" content="1200" />',
            '<meta property="og:image:height" content="630" />',
            '<meta property="og:image:alt" content="A price of $450 landing inside a bet of $380 to $520 on the CashOrTrash range slider" />',
            '<meta name="twitter:card" content="summary_large_image" />',
          ]
        : []),
    ].join('\n');

    const head = html.indexOf('<head>');
    if (head === -1) {
      // Serving the page without a card is a worse share, not a broken site.
      this.logger.warn(
        'assets/landing.html has no <head>; serving it without social card metadata',
      );
      return html;
    }

    return `${html.slice(0, head + '<head>'.length)}\n${tags}${html.slice(head + '<head>'.length)}`;
  }

  private sendDocument(reply: FastifyReply, title: string, body: string): void {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · CashOrTrash</title><style>body{margin:0;background:#f5ead8;color:#201e1d;font:17px/1.6 system-ui,sans-serif}main{max-width:760px;margin:auto;padding:48px 24px 80px}h1,h2{line-height:1.15}h1{font-size:clamp(2rem,7vw,3.5rem)}h2{margin-top:2rem}a{color:#8a461f}nav{margin-bottom:2rem}</style></head><body><main><nav><a href="/">CashOrTrash</a></nav><h1>${title}</h1>${body}</main></body></html>`;
    void reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'public, max-age=300')
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      )
      .send(html);
  }

  private async load(): Promise<{ html: Buffer; etag: string } | null> {
    if (this.page) return this.page;
    for (const path of LANDING_ASSET_PATHS) {
      let source: string;
      try {
        source = await readFile(path, 'utf8');
      } catch (error) {
        // Only "not here" tries the next layout — a permission error or a bad
        // mount is a deployment fault worth surfacing, not a layout difference.
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        throw error;
      }

      const html = Buffer.from(this.withSocialCard(source), 'utf8');
      // Hashed after injection, so the ETag describes the bytes actually sent.
      // Hashing the file would let a change of origin serve stale metadata to
      // every client still holding the old validator.
      const etag = `"${createHash('sha256').update(html).digest('hex')}"`;
      this.page = { html, etag };
      return this.page;
    }
    this.logger.error(
      `Could not read assets/landing.html from any of: ${LANDING_ASSET_PATHS.join(', ')}`,
    );
    return null;
  }
}
