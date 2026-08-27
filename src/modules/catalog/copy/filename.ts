/**
 * Reading an item off its filename.
 *
 * `items/<category>/<description>_<price in USD>.<ext>` is the whole authoring
 * format. It carries the two things nothing downstream can invent — what the
 * object is, and what it actually costs — and everything else about the row is
 * derived from those or written by the copywriter.
 *
 * `ImageProcessor` makes the game derivative 1080×864, strips metadata, and
 * rejects unsafe or animated sources. Authors should still choose a sensible
 * crop, but the importer no longer requires them to pre-render an exact size.
 */

export const IMAGE_EXT = /\.(jpe?g|png|webp|avif)$/i;

/** Card conditions, as abbreviated in a filename. */
const CARD_GRADES: Record<string, string> = {
  nm: 'Near Mint',
  lp: 'Lightly Played',
  mp: 'Moderately Played',
  hp: 'Heavily Played',
  good: 'Good',
  po: 'Poor',
  foil: 'Foil',
};

/**
 * Names the title-caser would otherwise mangle, and abbreviations it would
 * leave lowercase. Applied before and after casing: before, so a pattern can
 * match the raw lowercase filename; after, so one can fix what casing did.
 *
 * This is a fallback. The copywriter writes the title a player sees, and gets
 * these as its input — so a marque missing here reaches the model as typed and
 * is usually fixed anyway. What this guarantees is the floor: the title is
 * still presentable when the model declines, leaks, or is unreachable.
 */
const TITLE_FIXES: ReadonlyArray<[RegExp, string]> = [
  [/\balpha romeo\b/gi, 'Alfa Romeo'],
  [/\broles\b/gi, 'Rolex'],
  [/\byatchmaster\b/gi, 'Yachtmaster'],
  [/\bpatek philippe\b/gi, 'Patek Philippe'],
  [/\bhawker beechcraft\b/gi, 'Hawker Beechcraft'],
  [/\bsu marine\b/gi, 'SU Marine'],
  [/\byugh?ioh\b/gi, 'Yu-Gi-Oh!'],
  [/\bmtg\b/gi, 'MTG'],
  [/\bblue eyed white dragon\b/gi, 'Blue-Eyes White Dragon'],
  [/\burza's legacy\b/gi, "Urza's Legacy"],
  [/\bgts\b/gi, 'GTS'],
  [/\bgt\b/gi, 'GT'],
  [/\bsf90\b/gi, 'SF90'],
  [/\bsl\b/gi, 'SL'],
  [/\bcla250\b/gi, 'CLA 250'],
  [/\b250sl\b/gi, '250 SL'],
  [/\bs-class amg\b/gi, 'S-Class AMG'],
  [/\bm4\b/gi, 'M4'],
  [/\bx6 m\b/gi, 'X6 M'],
  [/\bbmw\b/gi, 'BMW'],
  [/\bsf50-g2\b/gi, 'SF50-G2'],
  [/\bia\(390\)/gi, 'IA (390)'],
  [/\bii\b/gi, 'II'],
];

const LOWERCASE_WORDS = new Set([
  'and',
  'the',
  'of',
  'a',
  'an',
  'to',
  'in',
  'on',
  'for',
  'with',
]);

export function titleCase(input: string): string {
  return input
    .split(/\s+/)
    .map((word, index) => {
      const lower = word.toLowerCase();
      // Already carries an interior capital — a model number like `SF50-G2`
      // that lowercasing would destroy.
      if (/[A-Z]/.test(word.slice(1))) return word;
      if (index > 0 && LOWERCASE_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

export function applyFixes(title: string): string {
  return TITLE_FIXES.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    title,
  );
}

export interface ParsedFilename {
  /** The description as typed, underscores already spaces. */
  rawText: string;
  /** A presentable title, used when the copywriter cannot supply one. */
  fallbackTitle: string;
  /** What the filename said about condition — a year, or a card grade. */
  fallbackCondition: string;
  priceCents: number;
}

/**
 * Splits on the **last** underscore, not the first.
 *
 * `cessna 150_1967_82500.jpg` is a Cessna 150 from 1967 at $82,500. Splitting
 * on the first underscore prices it at "1967_82500", which parses as nothing
 * and drops the item.
 */
export function parseFilename(file: string): ParsedFilename | null {
  const base = file.replace(IMAGE_EXT, '');
  const cut = base.lastIndexOf('_');
  if (cut <= 0) return null;

  const price = Number(base.slice(cut + 1));
  if (!Number.isFinite(price) || price <= 0) return null;

  const rawText = base.slice(0, cut).replace(/_/g, ' ').trim();
  if (!rawText) return null;

  const split = splitCondition(rawText);

  return {
    rawText,
    fallbackTitle: applyFixes(titleCase(applyFixes(split.title))).trim(),
    fallbackCondition: split.conditionLine,
    // Prices are whole USD in the filename; cents are the storage unit.
    priceCents: Math.round(price * 100),
  };
}

/**
 * Pulls what the filename says about the object out of it, leaving the name
 * behind.
 *
 * Two shapes in this catalogue: vehicles and watches carry a model year, cards
 * carry a grade abbreviation. Both belong under the photograph rather than in
 * the title.
 *
 * Only ever reports what the text actually carried. An empty line is the honest
 * answer for a filename that said nothing, and it used to be filled with the
 * word "Used" — which is not a fact about the object, it is a guess, and the
 * copywriter is told the contents of this field are factual. That fabrication
 * came back as "Used · 81m² apartment in Piazza Bologna": a word that says
 * nothing about a flat, asserted as though the filename had stated it.
 */
export function splitCondition(rawText: string): {
  title: string;
  conditionLine: string;
} {
  const words = rawText.trim().split(/\s+/);
  const last = words[words.length - 1]?.toLowerCase() ?? '';

  // A grade is a real condition statement, made by a grader — the one case
  // where the filename genuinely knows.
  const grade = CARD_GRADES[last];
  if (grade) {
    return { title: words.slice(0, -1).join(' '), conditionLine: grade };
  }

  // A year is an era, not a condition. It is carried through because it is a
  // fact worth having under the photograph; what it is not is evidence that
  // the object is worn.
  const year = /^(19|20)\d{2}$/.test(last) ? last : null;
  if (year) {
    return { title: words.slice(0, -1).join(' '), conditionLine: year };
  }

  return { title: rawText, conditionLine: '' };
}
