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

type Pattern = readonly [RegExp, string];

/**
 * Currency shapes, which are near enough universal to share.
 *
 * The symbol test carries the ones these markets actually price in; the word
 * test is per language and lives with its language below. `R$` is covered by
 * the `$` in the class, which is the point of testing the symbol rather than
 * the full token.
 */
const CURRENCY_SYMBOL: Pattern = [/[$€£¥]\s?\d/u, 'a currency amount'];

const ENGLISH: readonly Pattern[] = [
  CURRENCY_SYMBOL,
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
  CURRENCY_SYMBOL,
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
  CURRENCY_SYMBOL,
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
  CURRENCY_SYMBOL,
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
  for (const [pattern, why] of PATTERNS[locale]) {
    const hit = pattern.exec(text);
    if (hit) return `${why} ("${hit[0]}")`;
  }
  return null;
}
