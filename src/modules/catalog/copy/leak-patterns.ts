/**
 * What a description must never contain, in each language the game ships.
 *
 * The model is never shown a price, so a leak is the model reasoning from what
 * it knows about the object rather than repeating something we told it — "one
 * of the most valuable cards ever printed" gives the answer away without a
 * number in it. Prompting alone does not reliably stop that, so the output is
 * filtered as well; this file is that filter.
 *
 * It is per language because the filter is the only thing standing behind the
 * prompt, and an English-only one is no filter at all for Spanish, Portuguese
 * or Italian. `raro`, `prezioso`, `de colección` and `de luxo` all sail past
 * every pattern written for English while handing the player the answer, and —
 * worse — they do it in a log line that whoever is reading it may not be able
 * to read. A locale with no entry here is refused outright by the copywriter
 * rather than generated unfiltered; see `hasLeakPatterns`.
 *
 * Scarcity as a plain fact is allowed and is not in these lists ("one of 400
 * built", "un solo anno di produzione"). Scarcity as an appraisal is what is
 * caught.
 */

/** The language subtags the copywriter is allowed to write. Mirrors the app's `SUPPORTED_LOCALES`. */
export const COPY_LOCALES = ['es', 'pt', 'it'] as const;

export type CopyLocale = (typeof COPY_LOCALES)[number];

/** Every language the filter knows, English included — English is what `ItemCopywriter` vets against. */
export type LeakLocale = 'en' | CopyLocale;

/**
 * A shape to look for, what to call it in the log, and optionally a way to
 * excuse one particular hit.
 *
 * The excuse sees only the matched text, and is checked per occurrence — so
 * "4K display · listed at 45k" is excused for the first and still caught on
 * the second. Context the hit alone cannot carry (the word after it, the word
 * before) belongs in the pattern's own lookarounds instead.
 */
type Pattern =
  | readonly [RegExp, string]
  | readonly [RegExp, string, (hit: string) => boolean];

/**
 * Currency shapes, which are near enough universal to share.
 *
 * The symbol test carries the ones these markets actually price in; the word
 * test is per language and lives with its language below. `R$` is covered by
 * the `$` in the class, which is the point of testing the symbol rather than
 * the full token.
 *
 * Both sides of the number, because only English puts the symbol first:
 * "12.000€" and "12 500 €" are how Spanish and Italian write a price, and a
 * symbol-first test waved both through. `\s` covers the no-break and narrow
 * no-break spaces a French-style "12 500 €" is typeset with. The optional
 * `k`/`M` catches "45k€" and "1,2 M€".
 */
const CURRENCY_SYMBOL: Pattern = [/[$€£¥]\s?\d/u, 'a currency amount'];
const CURRENCY_SYMBOL_AFTER: Pattern = [
  /\d\s?(?:[kKmM]{1,2}\s?)?[$€£¥]/u,
  'a currency amount',
];

/**
 * ISO codes, either side of the number — "CHF 9,000" as much as "9,000 CHF".
 *
 * Shared rather than per language because a code is not a word in any of them.
 * The list is the currencies these markets and this catalogue plausibly price
 * in, not all of ISO 4217: most three-letter codes are also ordinary syllables
 * ("cop", "all", "top"), and each one added is a new way for a spec line to be
 * thrown away.
 */
const ISO_CODES = 'usd|eur|gbp|chf|brl|jpy|cad|aud|mxn|ars|clp';
const CURRENCY_CODE: Pattern = [
  new RegExp(`\\b(?:${ISO_CODES})\\s?\\d|\\d\\s?(?:${ISO_CODES})\\b`, 'i'),
  'a currency amount',
];

/**
 * Nouns a round number is routinely attached to in a specification — a
 * production run, a distance, an engine speed, a screen. A magnitude followed
 * by one of these is a count or a measurement, not a price. All four
 * languages at once: the list is only ever read as an exclusion, and a Spanish
 * unit turning up in English copy costs nothing.
 */
const NOT_MONEY_AFTER = [
  // counts
  'units?',
  'copies',
  'built',
  'made',
  'produced',
  'examples',
  'pieces',
  'people',
  'players',
  'unidades',
  'ejemplares',
  'exemplares',
  'piezas',
  'pe[çc]as',
  'c[óo]pias',
  'fabricad\\w*',
  'producid\\w*',
  'produzid\\w*',
  'habitantes',
  'personas',
  'pessoas',
  'unit[àa]',
  'esemplari',
  'pezzi',
  'copie',
  'prodott\\w*',
  'costruit\\w*',
  'abitanti',
  'persone',
  // distance and running time
  'miles?',
  'mi\\b',
  'km',
  'kilomet\\w*',
  'kil[óo]metros',
  'quil[óô]metros',
  'chilometri',
  'millas',
  'milhas',
  'miglia',
  'hours?',
  'hrs?\\b',
  'horas',
  'ore\\b',
  'rpm',
  'giri',
  'rev\\w*',
  // screens and cameras — see THOUSANDS_K
  'display',
  'screens?',
  'monitor',
  'tv\\b',
  'video',
  'resolu\\w*',
  'risoluzion\\w*',
  'hdr',
  'uhd',
  'oled',
  'lcd',
  'pantalla',
  'tela',
  'schermo',
  'cameras?',
  'c[áâa]mara',
  'c[âa]mera',
  'fotocamera',
  // precious metal — "18k yellow gold"
  'gold',
  'yellow',
  'white',
  'rose',
  'red',
  'pink',
  'solid',
  'plated',
  'karat',
  'carat',
  'kt\\b',
  'ct\\b',
  'oro',
  'ouro',
].join('|');

/**
 * "(of|de|di) <noun>" after the magnitude, so "1,2 millones de unidades" and
 * "2 million of them built" read as the counts they are.
 */
const NOT_MONEY = `(?!\\s*(?:(?:of|de|di|da)\\s+)?(?:${NOT_MONEY_AFTER}))`;

/** Every number in a phrase begins here — not partway through "A4" or "1.200". */
const NUMBER = '(?<![\\p{L}\\d.,])\\d[\\d.,]*';

/**
 * A thousands suffix: "listed at 45k", "circa 12k", "12.5K".
 *
 * This is the pattern most likely to eat a fact, because `k` is also a karat
 * and a screen resolution, and a catalogue of watches and televisions writes
 * both constantly. The tradeoff, deliberately in the blocking direction:
 *
 * - Karat gold is excused by context either side — "18k yellow gold" by the
 *   word after, "oro amarillo de 18k" by the metal word up to two words before. A bare "18k" at
 *   the end of a clause with no metal nearby is caught: the prompt's own
 *   example writes the metal, and a missed price is the worse failure.
 * - Resolution is excused when it is written the way resolution is written — a
 *   single digit and a capital K with nothing between ("4K", "8K"), or any
 *   case followed by a screen word ("4k display"). "About 4k" in lowercase is
 *   still caught; "sold for 4K" is caught by `sold` regardless. What slips
 *   through is a single-digit thousands price in capitals with no other hint,
 *   which is the price of not dropping every television's description.
 * - Mileage, rpm and production counts are excused by the noun after them
 *   ("45k miles", "8k rpm", "20k units").
 */
const THOUSANDS_K: Pattern = [
  new RegExp(
    `(?<!(?:gold|oro|ouro|karat|carat|quilates|carati)\\W+(?:\\p{L}+\\W+){0,2})${NUMBER}\\s?k\\b${NOT_MONEY}`,
    'iu',
  ),
  'an amount in thousands',
  (hit) => /^[2-8]K$/.test(hit),
];

/** A magnitude word or abbreviation after a number, in one language's terms. */
const magnitude = (words: string): Pattern => [
  new RegExp(`${NUMBER}\\s?(?:${words})\\b${NOT_MONEY}`, 'iu'),
  'an amount in thousands or millions',
];

/** Every language's copy is checked against these before its own list. */
const SHARED: readonly Pattern[] = [
  CURRENCY_SYMBOL,
  CURRENCY_SYMBOL_AFTER,
  CURRENCY_CODE,
  THOUSANDS_K,
];

const ENGLISH: readonly Pattern[] = [
  ...SHARED,
  // Not a bare `m`: "2m" is two metres far more often than two million.
  magnitude('million|millions|billion|billions|bn|mn'),
  // "45 grand" — with the pianos, and the other things called Grand, let off.
  [
    /\b\d[\d,.]*\s?grand\b(?!\s+(piano|prix|tour|touring|cru|slam|sport|seiko|cherokee|marquis|national))/i,
    'an amount in thousands',
  ],
  [
    /\b\d[\d,.]*\s?(usd|eur|gbp|dollars?|euros?|pounds?)\b/i,
    'a currency amount',
  ],
  [
    /\b(price|priced|pricing|cost|costs|costly|worth|value|valued|valuable|expensive|cheap|inexpensive|affordable|premium|budget)\b/i,
    'a value judgement',
  ],
  [
    /\b(rare|scarce|sought[- ]after|collectible|collector'?s?|investment|appreciat(e|ed|ing|ion)|desirable|coveted|prized|grail|holy grail)\b/i,
    'a desirability claim',
  ],
  [
    /\b(auction|sold|sells|resale|market|msrp|retail|sticker|bidding|hammer)\b/i,
    'a market reference',
  ],
  // `level` as well as `end`: the prompt names "entry-level" among the tier
  // words it forbids, and this list is what catches the prompt being ignored —
  // so a term the instructions rule out but the filter waves through is the one
  // combination that has no backstop at all. Deliberately not `mid-range`,
  // which is a factual specification on a loudspeaker.
  [/\b(low|high|top|entry)[- ](end|level)\b/i, 'a market-tier claim'],
  [/\b(luxury|exclusive|flagship|halo)\b/i, 'a market-tier claim'],
];

/**
 * Spanish.
 *
 * Adjectives are matched with their gender and number endings folded into the
 * pattern (`car[oa]s?`) rather than as four alternatives, because the model
 * will agree them with whatever noun it chose and a list of masculine singulars
 * would catch a quarter of the cases. The same applies to Portuguese and
 * Italian below.
 */
const SPANISH: readonly Pattern[] = [
  ...SHARED,
  // `mil` only with the count and distance nouns excused: "12 mil km" is an
  // odometer, "12 mil" on its own is a price.
  magnitude('mil|mill[óo]n|millones|millardos?'),
  [
    /\b\d[\d.,]*\s?(usd|eur|gbp|d[óo]lares?|euros?|libras?)\b/i,
    'a currency amount',
  ],
  [
    /\b(precio|precios|cuesta|cuestan|costar|coste|costo|vale|valen|val[íi]a|valor|valorad[oa]s?|car[oa]s?|barat[oa]s?|asequibles?|econ[óo]mic[oa]s?|prohibitiv[oa]s?)\b/i,
    'a value judgement',
  ],
  [
    /\b(rar[oa]s?|rareza|escas[oa]s?|codiciad[oa]s?|buscad[íi]sim[oa]s?|coleccionistas?|de\s+colecci[óo]n|inversi[óo]n|revaloriza\w*|apreciad[oa]s?|codicia\w*)\b/i,
    'a desirability claim',
  ],
  [
    /\b(subasta\w*|remate\w*|vendid[oa]s?|se\s+vende\w*|reventa|mercado|precio\s+de\s+venta|pvp|minorista)\b/i,
    'a market reference',
  ],
  [
    /\b(lujo|lujos[oa]s?|exclusiv[oa]s?|gama\s+(alta|baja|media)|buque\s+insignia|premium|de\s+entrada)\b/i,
    'a market-tier claim',
  ],
];

/** Portuguese. Written to cover both European and Brazilian forms — `caro`/`barato` are shared, `grife` is Brazilian. */
const PORTUGUESE: readonly Pattern[] = [
  ...SHARED,
  // `mi` and `bi` are how Brazilian copy abbreviates milhão and bilhão.
  magnitude('mil|milh[ãa]o|milh[õo]es|bilh[ãa]o|bilh[õo]es|mi|bi'),
  [
    /\b\d[\d.,]*\s?(usd|eur|gbp|brl|d[óo]lares?|euros?|libras?|reais)\b/i,
    'a currency amount',
  ],
  [
    /\b(pre[çc]o\w*|custa\w*|custo\w*|vale\w*|valia\w*|valor\w*|valios[oa]s?|car[oa]s?|barat[oa]s?|acess[íi]ve\w*|econ[óo]mic[oa]s?|proibitiv[oa]s?)\b/i,
    'a value judgement',
  ],
  [
    /\b(rar[oa]s?|raridade|escass[oa]s?|cobi[çc]ad[oa]s?|procurad[íi]ssim[oa]s?|colecionad\w*|colecion[áa]ve\w*|de\s+cole[çc][ãa]o|investimento|valoriza\w*)\b/i,
    'a desirability claim',
  ],
  [
    /\b(leil[ãa]o|leiload\w*|vendid[oa]s?|revenda|mercado|varejo|retalho|tabela\w*)\b/i,
    'a market reference',
  ],
  [
    /\b(luxo|luxuos[oa]s?|exclusiv[oa]s?|gama\s+(alta|baixa|m[ée]dia)|topo\s+de\s+gama|carro-chefe|grife|premium|de\s+entrada)\b/i,
    'a market-tier claim',
  ],
];

/** Italian. */
const ITALIAN: readonly Pattern[] = [
  ...SHARED,
  magnitude('mila|milion[ei]|miliard[oi]|mln|mld|mrd'),
  [
    /\b\d[\d.,]*\s?(usd|eur|gbp|dollari?|euro|sterline?)\b/i,
    'a currency amount',
  ],
  [
    /\b(prezz\w+|costa\w*|costano|costo\w*|vale\w*|valgono|valeva\w*|valore\w*|prezios[oi]\w*|car[oaie]\b|cost[oa]s[oaie]\b|economic[oaie]\b|abbordabil\w*|accessibil\w*)\b/i,
    'a value judgement',
  ],
  [
    /\b(rar[oaie]\b|rarit[àa]|scars\w+|ricercat[oaie]\b|ambit[oaie]\b|collezionist\w*|da\s+collezione|investiment\w*|rivaluta\w*|introvabil\w*)\b/i,
    'a desirability claim',
  ],
  [
    /\b(asta|aste|battut[oa]\s+all'asta|vendut[oaie]\b|rivendit\w*|mercato|listino|al\s+dettaglio)\b/i,
    'a market reference',
  ],
  [
    /\b(lusso|lussuos[oaie]\b|esclusiv[oaie]\b|fascia\s+(alta|bassa|media)|ammiraglia|premium|di\s+base)\b/i,
    'a market-tier claim',
  ],
];

const PATTERNS: Record<LeakLocale, readonly Pattern[]> = {
  en: ENGLISH,
  es: SPANISH,
  pt: PORTUGUESE,
  it: ITALIAN,
};

export function hasLeakPatterns(locale: string): locale is LeakLocale {
  // `hasOwn`, not `in`: `in` walks the prototype, so `'toString'` and
  // `'constructor'` would satisfy a guard whose entire job is to refuse a
  // language nothing can check — and the caller would then iterate a function
  // as if it were a pattern list. No real subtag collides today; this is a
  // guard for the commit where the locale list stops being hand-written.
  return Object.hasOwn(PATTERNS, locale);
}

/**
 * What in `text` gives the answer away, or null.
 *
 * The reason is returned in English on purpose: it goes into a log line read by
 * whoever runs the import, who may not read the language the copy is in.
 */
export function findPriceLeak(
  text: string,
  locale: LeakLocale = 'en',
): string | null {
  for (const [pattern, why, excused] of PATTERNS[locale]) {
    // Every occurrence, not the first: an excused "4K" early in the line must
    // not hide a "45k" later in it.
    const global = new RegExp(pattern.source, `${pattern.flags}g`);
    for (const hit of text.matchAll(global)) {
      if (!excused?.(hit[0])) return `${why} ("${hit[0]}")`;
    }
  }
  return null;
}
