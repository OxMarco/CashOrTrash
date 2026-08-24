import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import {
  DEFAULT_LANGUAGE,
  Language,
  SUPPORTED_LANGUAGES,
} from '../language.constants';

/**
 * The language a prose-bearing response should speak, as a query parameter.
 *
 * A query parameter rather than `Accept-Language`, and for the same reason
 * `?currency` is one: the app already has an explicit in-app language setting
 * that overrides the device, so the header would be answering a question the
 * client is not asking. It also keeps the language visible in a URL, which is
 * what makes a cached response distinguishable from one in another language.
 *
 * A class rather than a bare `@Query('lang')` because the global pipe runs
 * `forbidNonWhitelisted`: an unknown language is refused at the edge, so no
 * endpoint has to decide what to do with `?lang=xx`.
 */
export class LanguageQueryDto {
  @ApiPropertyOptional({
    enum: SUPPORTED_LANGUAGES,
    default: DEFAULT_LANGUAGE,
    description:
      'Omitted means English. An item with no copy in the language asked for ' +
      'falls back to its English title and description rather than 404ing.',
  })
  @IsOptional()
  @IsIn(SUPPORTED_LANGUAGES)
  lang?: Language;
}
