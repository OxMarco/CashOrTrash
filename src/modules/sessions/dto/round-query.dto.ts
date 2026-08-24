import { IntersectionType } from '@nestjs/swagger';

import { LanguageQueryDto } from '../../catalog/dto/language.dto';
import { CurrencyQueryDto } from '../../currency/dto/currency.dto';

/**
 * The two things a round can be asked for: money in a currency, prose in a
 * language.
 *
 * `IntersectionType` rather than a hand-written class with both fields, so the
 * validation decorators and the OpenAPI metadata come from the one declaration
 * of each — and so `?lang` picks up new languages by editing
 * `SUPPORTED_LANGUAGES`, not by editing every endpoint that accepts it.
 *
 * They are separate settings in the app and stay separate here: a player can
 * reasonably read Italian and think in dollars.
 */
export class RoundQueryDto extends IntersectionType(
  CurrencyQueryDto,
  LanguageQueryDto,
) {}
