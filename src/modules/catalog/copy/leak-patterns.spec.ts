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
