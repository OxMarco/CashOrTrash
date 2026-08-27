import { parseFilename, splitCondition, titleCase } from './filename';

describe('parseFilename', () => {
  /**
   * The case the whole format turns on. A description may legitimately contain
   * an underscore, so the price is whatever follows the *last* one.
   */
  it('reads the price after the last underscore, not the first', () => {
    const parsed = parseFilename('cessna 150_1967_82500.jpg');

    expect(parsed?.priceCents).toBe(8_250_000);
    expect(parsed?.rawText).toBe('cessna 150 1967');
  });

  it('reads a plain description and price', () => {
    const parsed = parseFilename('rolex daytona 2016_20600.webp');

    expect(parsed?.priceCents).toBe(2_060_000);
    expect(parsed?.fallbackTitle).toBe('Rolex Daytona');
    expect(parsed?.fallbackCondition).toBe('2016');
  });

  it.each(['jpg', 'jpeg', 'png', 'webp', 'avif'])(
    'accepts a .%s source',
    (ext) => {
      expect(parseFilename(`pebble mouse_25.${ext}`)?.priceCents).toBe(2_500);
    },
  );

  it.each([
    ['no price at all', 'just a name.jpg'],
    ['a price that is not a number', 'thing_abc.jpg'],
    ['a zero price', 'thing_0.jpg'],
    ['a negative price', 'thing_-5.jpg'],
    ['nothing before the underscore', '_500.jpg'],
  ])('refuses %s', (_label, file) => {
    expect(parseFilename(file)).toBeNull();
  });

  it('carries a card grade into the condition rather than the title', () => {
    const parsed = parseFilename('mtg black lotus beta good_49515.jpg');

    expect(parsed?.fallbackTitle).toBe('MTG Black Lotus Beta');
    expect(parsed?.fallbackCondition).toBe('Good');
  });

  it('corrects the marques the title-caser would otherwise mangle', () => {
    expect(
      parseFilename('alpha romeo giulietta 1959_30000.jpg')?.fallbackTitle,
    ).toBe('Alfa Romeo Giulietta');
    expect(parseFilename('roles yatchmaster 2_17100.webp')?.fallbackTitle).toBe(
      'Rolex Yachtmaster 2',
    );
  });
});

describe('titleCase', () => {
  it('leaves a model number that already carries an interior capital', () => {
    expect(titleCase('cirrus vision jet SF50-G2')).toBe(
      'Cirrus Vision Jet SF50-G2',
    );
  });

  it('lowercases joining words, except when they lead', () => {
    expect(titleCase('the statue of liberty')).toBe('The Statue of Liberty');
  });
});

describe('splitCondition', () => {
  /**
   * The whole point of the field: it reports what the filename said, and a
   * filename that said nothing about condition reports nothing. It used to
   * answer "Used" here, which the copywriter is told to treat as fact and duly
   * wrote into the description — "Used · 81m² apartment in Piazza Bologna",
   * a classification invented one layer down and asserted two layers up.
   */
  it('says nothing when the filename said nothing', () => {
    expect(splitCondition('pebble mouse')).toEqual({
      title: 'pebble mouse',
      conditionLine: '',
    });
  });

  /** A year is an era. It is not evidence that the object is worn. */
  it('carries a model year through without calling it wear', () => {
    expect(splitCondition('bmw m4 competition 2025')).toEqual({
      title: 'bmw m4 competition',
      conditionLine: '2025',
    });
  });

  it('does not mistake a number that is not a year for one', () => {
    expect(splitCondition('aula f99 pro keyboard')).toEqual({
      title: 'aula f99 pro keyboard',
      conditionLine: '',
    });
  });

  /** A grade is the one case where the filename genuinely knows. */
  it('keeps a grader verdict, which is a real condition statement', () => {
    expect(splitCondition('mtg black lotus beta good').conditionLine).toBe(
      'Good',
    );
  });
});
