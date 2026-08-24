import { ConfigService } from '@nestjs/config';

import {
  ItemCopywriter,
  MAX_CONDITION_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_TRANSLATED_CONDITION_LENGTH,
  MAX_TRANSLATED_TITLE_LENGTH,
} from './item-copywriter.service';
import { findPriceLeak, type LeakLocale } from './leak-patterns';

/**
 * The model is never shown a price, so anything it says about value is reasoned
 * from what it knows about the object — which is exactly the knowledge the
 * player is being tested on. Prompting alone does not reliably stop it, so the
 * output is filtered too, and this is that filter.
 */
describe('findPriceLeak', () => {
  it.each([
    ['$1,200 at the time', 'a currency amount'],
    ['around 400 USD', 'a currency amount'],
    ['a valuable example', 'a value judgement'],
    ['cheap for what it is', 'a value judgement'],
    ['a rare survivor', 'a desirability claim'],
    ['sought-after among collectors', 'a desirability claim'],
    ['sold at auction last year', 'a market reference'],
    ['well under MSRP', 'a market reference'],
    ['an entry-level model', 'a market-tier claim'],
    ['a high-end build', 'a market-tier claim'],
    ['the flagship of the range', 'a market-tier claim'],
  ])('rejects %j as %s', (text, why) => {
    expect(findPriceLeak(text)).toContain(why);
  });

  /**
   * A specification that happens to contain a tier word. The filter is the
   * backstop for a prompt that was ignored, and a backstop that eats facts
   * costs the player the description entirely — the item falls back to whatever
   * its filename said.
   */
  it('leaves a technical use of a tier word alone', () => {
    expect(
      findPriceLeak('Three-way · 6.5in mid-range driver · sealed'),
    ).toBeNull();
  });

  /**
   * Scarcity as a specification is a fact about the object; scarcity as an
   * appraisal is a hint about the answer. The line between them is the whole
   * reason this is a word list rather than a single "no scarcity" rule.
   */
  it.each([
    '1959 · 1.3-litre twin-cam four · steel body, drum brakes all round',
    'Manual wind, 18k yellow gold case, 31mm · box and papers',
    'One of 400 built · single production year · matching numbers',
    'Beta print, black border · light edge wear · unplayed since sleeving',
  ])('passes %j', (text) => {
    expect(findPriceLeak(text)).toBeNull();
  });

  it('names the phrase it caught, so a rejection can be read back', () => {
    expect(findPriceLeak('a rare find')).toBe('a desirability claim ("rare")');
  });
});

describe('ItemCopywriter', () => {
  const build = (openaiApiKey: string) =>
    new ItemCopywriter({
      getOrThrow: () => ({ openaiApiKey, openaiModel: 'gpt-5' }),
    } as unknown as ConfigService);

  it('writes nothing, and asks nothing, without a key', async () => {
    await expect(
      build('').write([
        {
          ref: 'a',
          category: 'watches',
          rawText: 'seiko',
          knownCondition: '1978',
        },
      ]),
    ).resolves.toEqual(new Map());
  });

  it('writes nothing for an empty request list', async () => {
    await expect(build('sk-test').write([])).resolves.toEqual(new Map());
  });

  describe('translating', () => {
    const request = {
      ref: 'a',
      category: 'watches',
      rawText: 'seiko 6139',
      english: {
        title: 'Seiko 6139',
        conditionLine: 'Automatic chronograph · 1978 · steel',
      },
    };

    it('translates nothing, and asks nothing, without a key', async () => {
      await expect(build('').translate('it', [request])).resolves.toEqual(
        new Map(),
      );
    });

    it('translates nothing for an empty request list', async () => {
      await expect(build('sk-test').translate('it', [])).resolves.toEqual(
        new Map(),
      );
    });

    /**
     * The guard that matters most here. The leak filter is the only thing
     * behind the prompt, so a language it has no patterns for would ship copy
     * that nothing can check — and ship it in a log line whoever runs the
     * import may not be able to read. Refusing is the safe answer: the item
     * falls back to English, which is a worse item and not a spoiled one.
     */
    it('refuses a language it has no leak patterns for', async () => {
      const writer = build('sk-test');
      const asked = jest
        .spyOn(writer as unknown as { ask: () => Promise<unknown> }, 'ask')
        .mockResolvedValue({ items: [] });

      await expect(writer.translate('de' as never, [request])).resolves.toEqual(
        new Map(),
      );
      expect(asked).not.toHaveBeenCalled();
    });
  });

  /**
   * `vet` is private, and deliberately so — but it is the only thing standing
   * between a leaked answer and the catalogue, so it is exercised here through
   * the shape the schema guarantees it will be handed.
   */
  describe('vetting a row the model returned', () => {
    const vet = (
      title: string,
      conditionLine: string,
      limits: { title: number; conditionLine: number; locale: LeakLocale } = {
        title: MAX_TITLE_LENGTH,
        conditionLine: MAX_CONDITION_LENGTH,
        locale: 'en',
      },
    ) =>
      (
        build('sk-test') as unknown as {
          vet: (
            row: { ref: string; title: string; conditionLine: string },
            limits: { title: number; conditionLine: number; locale: string },
          ) => unknown;
        }
      ).vet({ ref: 'r1', title, conditionLine }, limits);

    it('accepts copy that says what the object is', () => {
      expect(vet('Seiko 6139', 'Automatic chronograph · 1978 · steel')).toEqual(
        {
          title: 'Seiko 6139',
          conditionLine: 'Automatic chronograph · 1978 · steel',
        },
      );
    });

    it('trims before judging, so whitespace is not content', () => {
      expect(vet('  Seiko 6139  ', '  Automatic · 1978  ')).toEqual({
        title: 'Seiko 6139',
        conditionLine: 'Automatic · 1978',
      });
    });

    it.each([
      ['an empty title', '   ', 'Automatic · 1978'],
      ['an empty description', 'Seiko 6139', '   '],
      ['a leak in the title', 'Rare Seiko 6139', 'Automatic · 1978'],
      ['a leak in the description', 'Seiko 6139', 'A valuable automatic'],
    ])('drops the whole item for %s', (_case, title, conditionLine) => {
      expect(vet(title, conditionLine)).toBeNull();
    });

    /**
     * The same row, judged as English and as Italian. Both halves matter: a
     * translation held to the English ceiling would be rejected far more often
     * than an original, and an Italian line judged by the English word list
     * would not be judged at all.
     */
    it('judges a translation by its own language’s limits and filter', () => {
      const italian = {
        title: MAX_TRANSLATED_TITLE_LENGTH,
        conditionLine: MAX_TRANSLATED_CONDITION_LENGTH,
        locale: 'it' as const,
      };

      const long = 'y'.repeat(MAX_CONDITION_LENGTH + 20);
      expect(vet('Seiko 6139', long)).toBeNull();
      expect(vet('Seiko 6139', long, italian)).not.toBeNull();

      // `raro` is invisible to the English list and is exactly the leak this
      // whole per-language split exists to catch.
      expect(vet('Seiko 6139', 'Un esemplare molto raro')).not.toBeNull();
      expect(vet('Seiko 6139', 'Un esemplare molto raro', italian)).toBeNull();
    });

    it('drops copy too long for the column it has to fit', () => {
      expect(
        vet('x'.repeat(MAX_TITLE_LENGTH + 1), 'Automatic · 1978'),
      ).toBeNull();
      expect(
        vet('Seiko 6139', 'y'.repeat(MAX_CONDITION_LENGTH + 1)),
      ).toBeNull();
      // And accepts the boundary itself, which is what the column holds.
      expect(
        vet('x'.repeat(MAX_TITLE_LENGTH), 'Automatic · 1978'),
      ).not.toBeNull();
    });
  });
});
