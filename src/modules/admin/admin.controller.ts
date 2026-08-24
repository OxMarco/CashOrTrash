import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
// Side-effect import: this is what merges `isMultipart()` and `parts()` onto
// FastifyRequest. Without it the plugin works at runtime and the types do not.
import '@fastify/multipart';
import { FastifyReply, FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RawResponse } from 'src/common/interceptors/dto-serializer.interceptor';
import { Public } from 'src/common/decorators/public.decorator';
import { THEME_ICONS } from 'src/modules/catalog/theme-icons';
import { AdminAuthService } from './admin-auth.service';
import { AdminCatalogService } from './admin-catalog.service';
import { AdminGuard, AdminPublic } from './admin.guard';

/**
 * Two candidate paths, for the same reason the landing page has two: the Docker
 * image compiles `src/` alone and lands `dist/modules/admin`, while a local
 * `nest build` also compiles `scripts/` and pushes output a level deeper.
 */
const assetPaths = (file: string) => [
  join(__dirname, '..', '..', '..', 'assets', file),
  join(__dirname, '..', '..', '..', '..', 'assets', file),
];

/** The largest photograph the portal will accept, before processing. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

interface UploadedItem {
  themeId: number;
  title: string;
  conditionLine: string;
  priceCents: number;
  sourceUrl: string | null;
  photo: Buffer;
}

/**
 * The catalogue editor.
 *
 * Excluded from the OpenAPI document on purpose: the app's generated client is
 * built from that document, and these routes are not part of the app's API.
 * Keeping them out also keeps the portal's shape out of a public schema.
 *
 * The class carries `@Public()` to disengage the *global player* guard, which
 * would otherwise demand a device token no operator can produce, and
 * `AdminGuard` to put a stricter one back in its place. The handful of routes
 * that must answer without a token — the page, its two assets, and the login
 * that issues the token — are marked `@AdminPublic()`; everything else is
 * closed by saying nothing.
 */
@ApiExcludeController()
@Controller('admin')
@Public()
@UseGuards(AdminGuard)
// The global serializer would return `{}` for everything here: it is built for
// DTOs, and these routes return entities and literals on purpose. See
// `RawResponse` for why this controller is the one place that is correct.
@RawResponse()
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(
    private readonly auth: AdminAuthService,
    private readonly catalogue: AdminCatalogService,
  ) {}

  // --- the page --------------------------------------------------------------

  /**
   * The shell, served unauthenticated.
   *
   * It holds no catalogue data — everything on it arrives through the API
   * routes below, which are guarded. Serving the shell to anyone is what lets
   * the operator reach a login form at all.
   */
  @Get()
  @AdminPublic()
  async page(@Res() reply: FastifyReply): Promise<void> {
    await this.sendAsset(reply, 'admin.html', 'text/html; charset=utf-8');
  }

  @Get('admin.js')
  @AdminPublic()
  async script(@Res() reply: FastifyReply): Promise<void> {
    await this.sendAsset(
      reply,
      'admin.js',
      'application/javascript; charset=utf-8',
    );
  }

  @Get('admin.css')
  @AdminPublic()
  async stylesheet(@Res() reply: FastifyReply): Promise<void> {
    await this.sendAsset(reply, 'admin.css', 'text/css; charset=utf-8');
  }

  // --- session ---------------------------------------------------------------

  /**
   * The one route that cannot be guarded, since it is what issues the token.
   *
   * `@AdminPublic()` rather than an empty `@UseGuards()`: Nest composes guards
   * additively, so re-declaring them on the method would leave the class-level
   * `AdminGuard` running and make this route demand the token it exists to
   * issue. Rate limiting lives in `AdminAuthService`, against the caller's
   * address.
   */
  @Post('api/session')
  @AdminPublic()
  async login(
    @Body() body: { password?: unknown },
    @Req() request: FastifyRequest,
  ): Promise<{ token: string }> {
    const password = typeof body?.password === 'string' ? body.password : '';
    const token = await this.auth.login(password, request.ip ?? null);
    return { token };
  }

  // --- categories ------------------------------------------------------------

  @Get('api/icons')
  icons(): readonly string[] {
    return THEME_ICONS;
  }

  @Get('api/categories')
  async categories(): Promise<unknown[]> {
    return this.catalogue.listCategories();
  }

  @Post('api/categories')
  async createCategory(
    @Body() body: { name?: string; iconName?: string; sortOrder?: number },
  ): Promise<unknown> {
    return this.catalogue.createCategory({
      name: String(body?.name ?? ''),
      iconName: body?.iconName,
      sortOrder: Number(body?.sortOrder) || 0,
    });
  }

  @Patch('api/categories/:id')
  async toggleCategory(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { active?: boolean },
  ): Promise<{ ok: true }> {
    await this.catalogue.setCategoryActive(id, Boolean(body?.active));
    return { ok: true };
  }

  @Get('api/categories/:id/items')
  async items(@Param('id', ParseIntPipe) id: number): Promise<unknown[]> {
    return this.catalogue.listItems(id);
  }

  // --- items -----------------------------------------------------------------

  @Post('api/items')
  async createItem(@Req() request: FastifyRequest): Promise<unknown> {
    const upload = await this.readUpload(request);
    return this.catalogue.createItem(
      {
        themeId: upload.themeId,
        title: upload.title,
        conditionLine: upload.conditionLine,
        priceCents: upload.priceCents,
        sourceUrl: upload.sourceUrl,
      },
      upload.photo,
    );
  }

  @Patch('api/items/:id')
  async toggleItem(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { active?: boolean },
  ): Promise<{ ok: true }> {
    await this.catalogue.setItemActive(id, Boolean(body?.active));
    return { ok: true };
  }

  @Post('api/items/:id/copy')
  async requeue(@Param('id', ParseIntPipe) id: number): Promise<{ ok: true }> {
    await this.catalogue.requeueCopy(id);
    return { ok: true };
  }

  // --- internals -------------------------------------------------------------

  /**
   * Reads the multipart body by hand rather than through a DTO.
   *
   * The photograph and its fields arrive in one request, and the parts stream in
   * whatever order the browser sent them — so the fields are collected as they
   * pass and validated once the whole body has been read, rather than assuming
   * the file comes last.
   */
  private async readUpload(request: FastifyRequest): Promise<UploadedItem> {
    if (!request.isMultipart?.()) {
      throw new BadRequestException('Expected a multipart upload.');
    }

    const fields = new Map<string, string>();
    let photo: Buffer | null = null;

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        // Every part has to be drained even when it is not wanted, or the
        // request stalls waiting for a consumer that never arrives.
        const bytes = await part.toBuffer();
        if (part.fieldname !== 'photo') continue;
        // `limits.fileSize` truncates rather than throwing, so a file at
        // exactly the ceiling is indistinguishable from one that was cut off.
        // Refusing at the limit is the safe reading of an ambiguous result.
        if (bytes.byteLength >= MAX_UPLOAD_BYTES) {
          throw new BadRequestException(
            `That photograph is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
          );
        }
        photo = bytes;
      } else if (typeof part.value === 'string') {
        fields.set(part.fieldname, part.value);
      }
    }

    if (!photo || photo.byteLength === 0) {
      throw new BadRequestException('No photograph was uploaded.');
    }

    const themeId = Number(fields.get('themeId'));
    const priceCents = Number(fields.get('priceCents'));
    if (!Number.isSafeInteger(themeId) || themeId <= 0) {
      throw new BadRequestException('Pick a category.');
    }
    if (!Number.isSafeInteger(priceCents) || priceCents <= 0) {
      throw new BadRequestException('The price must be a positive amount.');
    }

    return {
      themeId,
      title: fields.get('title') ?? '',
      conditionLine: fields.get('conditionLine') ?? '',
      priceCents,
      sourceUrl: fields.get('sourceUrl') ?? null,
      photo,
    };
  }

  private contentSecurityPolicy(): string {
    const media = this.catalogue.mediaOrigin;
    return [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      `img-src 'self' data:${media ? ` ${media}` : ''}`,
      "connect-src 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join('; ');
  }

  private async sendAsset(
    reply: FastifyReply,
    file: string,
    contentType: string,
  ): Promise<void> {
    for (const path of assetPaths(file)) {
      try {
        const body = await readFile(path);
        void reply
          .header('content-type', contentType)
          // The global policy is `script-src 'none'`, which is right for an API
          // whose only other HTML is static marketing copy and wrong for the one
          // page here that has to run. Narrowed rather than widened globally:
          // scripts and styles from this origin only, still no inline anything,
          // and `img-src` opened just far enough to render item photographs
          // when they are served from a separate media origin.
          .header('content-security-policy', this.contentSecurityPolicy())
          // The portal is an operator tool; no crawler should hold a copy of it
          // and no proxy should serve a stale one after a deploy.
          .header('cache-control', 'no-store')
          .header('x-robots-tag', 'noindex, nofollow')
          .send(body);
        return;
      } catch {
        continue;
      }
    }
    this.logger.error(`Admin asset ${file} is missing from the image`);
    void reply.status(500).send('The admin portal assets are not installed.');
  }
}

export { MAX_UPLOAD_BYTES };
