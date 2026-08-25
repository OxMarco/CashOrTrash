import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Param,
  ParseIntPipe,
  Patch,
  PayloadTooLargeException,
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
import {
  AdminLoginDto,
  CreateCategoryDto,
  SetActiveDto,
} from './dto/admin.dto';
import { AdminGuard, AdminPublic } from './admin.guard';

/**
 * Two candidates, and which one resolves depends on whether this file is
 * running from source or from the build.
 *
 * `tsconfig.build.json` pins `rootDir` to the package root, so every build —
 * the Docker image included — lands the output at `dist/src/…`; the older
 * `dist/modules/…` shape the two paths were originally written for no longer
 * happens anywhere. What is left is still a real two-way split: under jest and
 * ts-node `__dirname` is `src/modules/admin`, three levels below the repository
 * root, while under `node dist/src/main.js` it is `dist/src/modules/admin`, four.
 * Tried in order, so the source layout wins where both could exist.
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
    @Body() body: AdminLoginDto,
    @Req() request: FastifyRequest,
  ): Promise<{ token: string }> {
    const token = await this.auth.login(body.password, request.ip ?? null);
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
  async createCategory(@Body() body: CreateCategoryDto): Promise<unknown> {
    return this.catalogue.createCategory({
      name: body.name,
      iconName: body.iconName,
      sortOrder: body.sortOrder ?? 0,
    });
  }

  @Patch('api/categories/:id')
  async toggleCategory(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: SetActiveDto,
  ): Promise<{ ok: true }> {
    await this.catalogue.setCategoryActive(id, body.active as boolean);
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
    @Body() body: SetActiveDto,
  ): Promise<{ ok: true }> {
    await this.catalogue.setItemActive(id, body.active as boolean);
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

    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          // Every part has to be drained even when it is not wanted, or the
          // request stalls waiting for a consumer that never arrives.
          const bytes = await part.toBuffer();
          if (part.fieldname !== 'photo') continue;
          if (photo) {
            throw new BadRequestException('Upload exactly one photograph.');
          }
          // Strictly over, matching the `fileSize` limit handed to
          // `@fastify/multipart`: a photograph of exactly the ceiling is one
          // the plugin accepts, and rejecting it here would refuse an upload
          // the configured limit permits.
          if (bytes.byteLength > MAX_UPLOAD_BYTES || part.file.truncated) {
            throw new PayloadTooLargeException(
              `That photograph is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
            );
          }
          photo = bytes;
        } else if (typeof part.value === 'string') {
          if (fields.has(part.fieldname)) {
            throw new BadRequestException(
              `Field "${part.fieldname}" was supplied more than once.`,
            );
          }
          fields.set(part.fieldname, part.value);
        }
      }
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : '';
      if (
        code === 'FST_REQ_FILE_TOO_LARGE' ||
        code === 'FST_FILES_LIMIT' ||
        code === 'FST_FIELDS_LIMIT' ||
        code === 'FST_PARTS_LIMIT'
      ) {
        throw new PayloadTooLargeException('The upload exceeds its limits.');
      }
      throw error;
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

    const title = (fields.get('title') ?? '').trim();
    const conditionLine = (fields.get('conditionLine') ?? '').trim();
    const sourceUrl = (fields.get('sourceUrl') ?? '').trim();
    if (title.length < 1 || title.length > 120) {
      throw new BadRequestException(
        'The item name must be between 1 and 120 characters.',
      );
    }
    if (conditionLine.length > 160) {
      throw new BadRequestException(
        'The description must be at most 160 characters.',
      );
    }
    if (sourceUrl.length > 512 || !isHttpUrl(sourceUrl)) {
      throw new BadRequestException('The source must be an HTTP or HTTPS URL.');
    }

    return {
      themeId,
      title,
      conditionLine,
      priceCents,
      sourceUrl: sourceUrl || null,
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
      let body: Buffer;
      try {
        body = await readFile(path);
      } catch (error) {
        // Only "not here" moves on to the next candidate. A permission error or
        // a bad mount is not the same thing as a layout difference between the
        // Docker image and a local build, and swallowing it as one turns a
        // fixable deployment fault into a bare 500 with nothing in the logs.
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        throw error;
      }

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
    }
    this.logger.error(`Admin asset ${file} is missing from the image`);
    void reply.status(500).send('The admin portal assets are not installed.');
  }
}

const isHttpUrl = (value: string): boolean => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

export { MAX_UPLOAD_BYTES };
