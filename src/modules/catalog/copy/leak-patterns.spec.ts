import { COPY_LOCALES, findPriceLeak, hasLeakPatterns } from './leak-patterns';

/**
 * The filter is the only thing standing behind the prompt, and the prompt is
 * the only thing standing between a model that knows what a Black Lotus is
 * worth and a player being told. These cases are the ones that would ship a
 * leak in a language the team cannot spot-check by reading the log.
 */
describe('finding a price leak', () => {
  describe.each(COPY_LOCALES)('in %s', (locale) => {
    it('has patterns at all', () => {
      expect(hasLeakPatterns(locale)).toBe(true);
    });

    it('catches the leak the English list would wave straight through', () => {
      // Every one of these passes `findPriceLeak(text, 'en')` untouched, which
      // is the whole reason this file is per language.
      const leaks: Record<typeof locale, string[]> = {
        es: [
          'Un ejemplar muy raro y codiciado',
          'Una pieza de colección, hoy inasequible',
          'Vendido en subasta el año pasado',
          'Reloj de lujo, gama alta',
          'Su valor no ha dejado de revalorizarse',
        ],
        pt: [
          'Um exemplar muito raro e cobiçado',
          'Peça de coleção, hoje inacessível',
          'Vendido em leilão no ano passado',
          'Relógio de luxo, topo de gama',
          'O seu valor tem vindo a valorizar-se',
        ],
        it: [
          'Un esemplare molto raro e ricercato',
          'Pezzo da collezione, ormai introvabile',
          'Venduto all’asta l’anno scorso',
          'Orologio di lusso, fascia alta',
          'Il suo valore continua a rivalutarsi',
        ],
      };

      for (const text of leaks[locale]) {
        expect(findPriceLeak(text, 'en')).toBeNull();
        expect(findPriceLeak(text, locale)).not.toBeNull();
      }
    });

    it('catches a currency amount however it is written', () => {
      const amounts: Record<typeof locale, string[]> = {
        es: [
          'Se vendió por 1.200 euros',
          '$1,200 en su día',
          'unos 900 dólares',
        ],
        pt: [
          'Vendido por 1.200 euros',
          'R$ 4.500 na altura',
          'cerca de 900 dólares',
        ],
        it: [
          'Venduto per 1.200 euro',
          '€ 1.200 all’epoca',
          'circa 900 dollari',
        ],
      };
      for (const text of amounts[locale]) {
        expect(findPriceLeak(text, locale)).not.toBeNull();
      }
    });

    /**
     * The shapes the first version of this filter missed. Every one is how a
     * price is ordinarily written somewhere these languages are spoken — the
     * symbol after the number, an ISO code, a magnitude word — and every one
     * reached a player's screen as a pass.
     */
    it('catches a price written after the number, as a code, or as a magnitude', () => {
      const amounts: Record<typeof locale, string[]> = {
        es: [
          '12.000€ nuevo',
          'unos 12 000 €',
          'EUR 1.200 en su día',
          'hoy ronda los 45k',
          'alrededor de 1,2 millones',
          'unos 12 mil',
          '1,2 M€',
        ],
        pt: [
          '12.000€ na altura',
          'BRL 4.500',
          '4.500 BRL',
          'cerca de 45k',
          'cerca de 1,2 milhões',
          'uns 12 mil',
          'R$ 1,2 mi',
        ],
        it: [
          'circa 12 500 €',
          '1,2 milioni',
          'CHF 9.000',
          'sui 45k',
          'circa 12 mila',
          '3 mln',
        ],
      };
      for (const text of amounts[locale]) {
        expect(findPriceLeak(text, locale)).not.toBeNull();
      }
    });

    /**
     * The magnitude patterns sit right next to a watch's karats, a car's
     * odometer and a television's resolution. Each of these is a spec line the
     * filter must leave alone, or the item loses its copy for stating a fact.
     */
    it('leaves karats, mileage, resolution and production counts alone', () => {
      const clean: Record<typeof locale, string[]> = {
        es: [
          'Caja de oro amarillo de 18k, 38 mm',
          'Oro 18k · esfera blanca',
          'Motor V8 · 45k km',
          'Solo 12 mil km desde nuevo',
          'Pantalla OLED 4K · 120 Hz',
          'Más de 1,2 millones de unidades fabricadas',
        ],
        pt: [
          'Caixa em ouro amarelo 18k, 38 mm',
          'Motor V8 · 45k km',
          '12 mil km desde novo',
          'Tela OLED 4K · 120 Hz',
          'Mais de 1,2 milhões de unidades produzidas',
        ],
        it: [
          'Cassa in oro giallo 18k, 38 mm',
          'Motore V8 · 45k km',
          'Solo 12 mila km',
          'Schermo OLED 4K · 120 Hz',
          'Oltre 1,2 milioni di esemplari prodotti',
        ],
      };
      for (const text of clean[locale]) {
        expect(findPriceLeak(text, locale)).toBeNull();
      }
    });

    it('leaves a plain specification alone, including scarcity as a fact', () => {
      // The line between a specification and an appraisal is the one thing a
      // filter this blunt can get wrong in the expensive direction: every false
      // positive here is an item that silently falls back to English.
      const clean: Record<typeof locale, string[]> = {
        es: [
          'Automático · 1978 · caja de acero de 38 mm',
          'Uno de los 400 fabricados · un solo año de producción',
          'Motor de cuatro cilindros y 1,3 litros · frenos de tambor',
        ],
        pt: [
          'Automático · 1978 · caixa de aço de 38 mm',
          'Um dos 400 fabricados · um único ano de produção',
          'Motor de quatro cilindros e 1,3 litros · travões de tambor',
        ],
        it: [
          'Automatico · 1978 · cassa in acciaio da 38 mm',
          'Uno dei 400 costruiti · un solo anno di produzione',
          'Motore quattro cilindri da 1,3 litri · freni a tamburo',
        ],
      };
      for (const text of clean[locale]) {
        expect(findPriceLeak(text, locale)).toBeNull();
      }
    });

    it('catches an adjective whatever gender and number it agreed to', () => {
      // The model agrees its adjectives with whatever noun it chose, so a list
      // of masculine singulars would catch roughly a quarter of the cases.
      const agreed: Record<typeof locale, string[]> = {
        es: ['una pieza rara', 'unas piezas raras', 'un objeto raro'],
        pt: ['uma peça rara', 'umas peças raras', 'um objeto raro'],
        it: ['una moneta rara', 'monete rare', 'un pezzo raro'],
      };
      for (const text of agreed[locale]) {
        expect(findPriceLeak(text, locale)).not.toBeNull();
      }
    });
  });

  describe('amounts in English beyond the symbol-first form', () => {
    it.each([
      'CHF 9,000',
      '9,000 CHF',
      'listed at 45k',
      'around 12.5K',
      'about 4k',
      'about 1.2 million',
      'roughly 3bn',
      '45 grand',
      '12 500 €',
      '45k€',
      // An excused "4K" early in the line must not hide the price after it.
      '4K display · listed at 45k',
    ])('catches %j', (text) => {
      expect(findPriceLeak(text)).not.toBeNull();
    });

    it.each([
      'Manual wind, 18k yellow gold case, 31mm',
      '18K white gold bracelet',
      '65-inch OLED · 4K · 120Hz',
      'Native 8K sensor',
      '4k display with HDR',
      '45k miles from new · one owner',
      'Redline at 8k rpm',
      'Over 2 million built · 1965',
      'One of 20k units made',
      'Steinway Model B · 1 grand piano bench included',
      'Built 1978 · restored 2019',
      '2m long, 40cm wide',
    ])('passes %j', (text) => {
      expect(findPriceLeak(text)).toBeNull();
    });
  });

  it('still catches everything it caught in English', () => {
    expect(findPriceLeak('a rare find')).toBe('a desirability claim ("rare")');
    expect(
      findPriceLeak('Three-way · 6.5in mid-range driver · sealed'),
    ).toBeNull();
  });

  it('knows a language it has no patterns for', () => {
    // `ItemCopywriter.translate` refuses on this, rather than writing copy that
    // nothing can check.
    expect(hasLeakPatterns('de')).toBe(false);
    expect(hasLeakPatterns('ja')).toBe(false);
  });

  it('has patterns for every language the copywriter may be asked to write', () => {
    // The guard that keeps the two lists from drifting: adding a locale to
    // COPY_LOCALES without adding its patterns fails here rather than shipping.
    for (const locale of COPY_LOCALES) {
      expect(hasLeakPatterns(locale)).toBe(true);
    }
  });
});
