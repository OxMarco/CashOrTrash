import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type {
  ResponseInput,
  ResponseInputContent,
} from 'openai/resources/responses/responses';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';

import { CopywritingConfig } from 'src/config/configuration';
import {
  findPriceLeak,
  hasLeakPatterns,
  type CopyLocale,
  type LeakLocale,
} from './leak-patterns';

/** The columns these have to fit. `item.conditionLine` is varchar(160). */
export const MAX_TITLE_LENGTH = 120;
export const MAX_CONDITION_LENGTH = 150;

/**
 * The same limits for a translation, against `item_copy`'s roomier columns.
 *
 * Spanish, Portuguese and Italian run 20-35% longer than English for the same
 * sentence. Held to the English ceiling, the length check would reject far more
 * translations than originals and leave a catalogue that is sparse in exactly
 * the languages this was built for — which reads as the model refusing, not as
 * a number set too low. The ceiling is still a real one: `UI.md` sizes the
 * reveal for a line, and a 220-character line is a paragraph.
 */
export const MAX_TRANSLATED_TITLE_LENGTH = 160;
export const MAX_TRANSLATED_CONDITION_LENGTH = 210;

/**
 * Items per request. Small enough that one refusal costs little — and half what
 * it was, because each item now carries its photograph. A refused batch throws
 * away four images' worth of request rather than eight, and a batch that would
 * otherwise be several megabytes of base64 stays a reasonable one.
 */
const BATCH_SIZE = 4;

const SYSTEM = `You write the title and the one-line description shown under an item's photograph in a price-guessing game.

The player sees your title, the photograph, your line, and a slider. They then guess what the object is worth. Your words are the only prose they get, so they have to help them reason — and they must never tell them the answer.

You are given the raw text of the item's filename, as typed by whoever added it. It is terse, sometimes misspelled, and sometimes has the model year or a card grade stuck on the end.

Most items also come with their photograph — the same photograph the player will be looking at while they read your line. Describe what is actually in it. Because the player has the picture too, naming what is visible in it gives nothing away; it is the appraisal of what you see that would, and that is forbidden below whether you got it from the picture or from what you know.

Write only what the photograph and the text support. If you cannot see how many rooms there are, do not say. If the floor is not visible, do not name it. A shorter true line beats a fuller invented one, and an invented detail is worse than a missing one because the player cannot tell it apart from a real one.

TITLE: name the object as a catalogue would. Correct the spelling and capitalisation of marques, models and proper nouns. Keep it specific — the model, not the category. Do not put the year or the condition in the title. Under 120 characters, no trailing full stop.

DESCRIPTION: write what the object IS — its specifics, materials, mechanism, era, configuration, and the concrete details an informed person would notice. Facts a knowledgeable owner would state plainly.

Condition only when you can actually see it or have been told it: visible wear, a restoration, a refit, a grader's verdict. With the photograph in front of you this is often answerable — a kitchen plainly refitted, a dial plainly marked, a car plainly repainted — and where it is, say so plainly. Never classify an object as new or used to fill the gap. For most of what is in this catalogue that classification says nothing — every apartment is used, every classic car is used — and asserting it from a photograph is a guess wearing the clothes of a fact. An object whose condition you do not know gets a line about what it is instead.

NEVER include, in either field, in any form:
- a price, a number of any currency, or a range
- whether the object is expensive, cheap, valuable, worthless, or a bargain
- whether it is rare, scarce, collectible, sought-after, desirable, or an investment
- auction results, market conditions, resale or retail context
- tier words like luxury, premium, entry-level, flagship, high-end

Scarcity as a plain fact is fine when it is a specification ("one of 400 built", "a single production year"). Scarcity as an appraisal is not ("very rare", "hard to find").

Style for the description: one line, no trailing full stop, under 150 characters. Use " · " to separate two or three clauses. Concrete over general. Match the register of a catalogue entry, not ad copy.

Good:
- title "Alfa Romeo Giulietta" / description "1959 · 1.3-litre twin-cam four · steel body, drum brakes all round · older restoration"
- title "Patek Philippe Calatrava" / description "Manual wind, 18k yellow gold case, 31mm · box and papers · light hairlines on the caseback"
- title "Black Lotus" / description "Beta print, black border · light edge wear, centred face · unplayed since sleeving"
- title "Kreuzberg Apartment" / description "Berlin, Kreuzberg · 74 m² over three rooms · Altbau, stucco ceilings, tiled stove"

Bad (all leak the answer):
- "A rare and highly sought-after example" — desirability claim
- "One of the most valuable cards ever printed" — value judgement
- "Recently sold at auction for a record sum" — market reference

The examples above show register and shape, and nothing else. Their details belong to those objects. If an item you are given happens to be the same model, the same card or a flat in the same district, you still write only what that item's own photograph and text support — never borrow a specification, a measurement or a feature from an example to fill a gap.`;

const LANGUAGE_NAMES: Record<CopyLocale, string> = {
  es: 'Spanish',
  pt: 'Portuguese',
  it: 'Italian',
};

/**
 * The translation pass.
 *
 * Deliberately says "write", not "translate". A literal rendering of "Beta
 * print, black border · light edge wear" reads like a manual in Italian, and
 * the register — a catalogue entry, not ad copy — is the half of the English
 * brief that a translation loses first. The English is supplied as the facts,
 * not as the sentence to mirror.
 *
 * It repeats the leak rules in full rather than referring to them. This runs as
 * its own request with its own instructions, so the model writing Italian has
 * never seen the English brief, and the one rule that matters is the one it
 * would otherwise be missing.
 */
function translationSystem(locale: CopyLocale): string {
  const language = LANGUAGE_NAMES[locale];
  return `You write, in ${language}, the title and the one-line description shown under an item's photograph in a price-guessing game.

You are given the English title and description for the same object, plus the raw filename text they were written from. Use them as the facts about the object. Do NOT translate them word for word: write what a ${language} catalogue would write about this object, in ${language} as it is actually written.

TITLE: name the object as a ${language} catalogue would. Marques, model names and other proper nouns stay in their original form — a Patek Philippe Calatrava is a Patek Philippe Calatrava in every language. Translate the common nouns around them, not the names. No trailing full stop.

DESCRIPTION: what the object IS — its specifics, materials, mechanism, era and configuration, and its condition where the English gives one. Where the English says nothing about condition, say nothing about it either — do not add a word for new or used to round the sentence out. One line, no trailing full stop. Use " · " to separate two or three clauses, as the English does.

The player sees your words, the photograph and a slider, and then guesses what the object is worth. NEVER include, in either field, in any form:
- a price, a number of any currency, or a range
- whether the object is expensive, cheap, valuable, worthless, or a bargain
- whether it is rare, scarce, collectible, sought-after, desirable, or an investment
- auction results, market conditions, resale or retail context
- tier words equivalent to luxury, premium, entry-level, flagship, high-end

This holds for the ${language} equivalents of those words, not only the English ones. Scarcity as a plain specification is fine ("one of 400 built"); scarcity as an appraisal is not ("very rare", "hard to find").

Keep the title under ${MAX_TRANSLATED_TITLE_LENGTH} characters and the description under ${MAX_TRANSLATED_CONDITION_LENGTH}. ${language} runs longer than English; if it will not fit, cut a clause rather than abbreviating words.`;
}

/**
 * The reply's shape, and the only thing the schema is asked to enforce.
 *
 * `zodTextFormat` compiles this into the strict JSON Schema the model is
 * constrained by *and* parses the reply back through it, so the structure is
 * guaranteed on both sides from one declaration — where it used to be a hand
 * written JSON Schema literal next to a `JSON.parse(...) as {...}` cast that
 * nothing checked.
 *
 * Deliberately no lengths and no content rules here, though Zod could express
 * both. A schema failure rejects the whole reply, and these come back
 * `BATCH_SIZE` items at a time: one overlong title would cost the rest of the
 * batch their copy.
 * `vet` applies those per item instead, drops only the offender, and says in
 * the log which rule it broke — see the note there.
 */
const CopyBatch = z.object({
  items: z.array(
    z.object({
      ref: z.string(),
      title: z.string(),
      conditionLine: z.string(),
    }),
  ),
});

type CopyRow = z.infer<typeof CopyBatch>['items'][number];

export interface CopyRequest {
  /** Opaque key the model echoes back, so a reordered reply still matches up. */
  ref: string;
  category: string;
  rawText: string;
  knownCondition: string;
  /** Titles already taken in this category, which this one must not repeat. */
  taken?: string[];
  /**
   * The item's photograph as a data URL, when there is one to send.
   *
   * Optional because a seed row, or one whose blob has been swept, still
   * deserves the copy its text can support — an item without a picture is
   * written from its words, exactly as every item was before.
   */
  photo?: string;
}

export interface ItemCopy {
  title: string;
  conditionLine: string;
}

/**
 * The model could not be reached, as opposed to the model saying no.
 *
 * The distinction the copy pass turns on. A refusal, a truncation or a leak is
 * an answer about *these items*, and asking again pays for the same answer —
 * so those are absorbed per batch and the item keeps its portal text. A dead
 * connection, a timeout, a 429 or a 5xx is an answer about *the provider*, and
 * says nothing about the items at all: clearing their flag on it would turn a
 * ten-minute outage into a catalogue with no descriptions that nothing ever
 * comes back to. Those stop the pass and are thrown, so the job retries and
 * the boot catch-up can find what is still flagged.
 *
 * Carries what was already written, so copy that has been paid for is not
 * thrown away with the error, and which refs got an answer of either kind — a
 * ref in `settled` but not in `partial` was declined, and is not re-asked.
 */
export class CopywriterUnavailableError extends Error {
  constructor(
    readonly partial: Map<string, ItemCopy>,
    readonly settled: ReadonlySet<string>,
    readonly reason: unknown,
  ) {
    super(
      `OpenAI unavailable: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
    this.name = 'CopywriterUnavailableError';
  }
}

/**
 * Whether a failed request says something about the provider rather than the
 * batch.
 *
 * Transport failures and timeouts, rate limits and 5xx are the obvious ones.
 * Auth (401/403) and a missing model (404) are here too: they are a
 * misconfiguration the operator has to fix, and every item that arrives while
 * the key is wrong deserves its copy once it is right — not a cleared flag and
 * an empty line. Only 400 and 422 are about the request itself (an image the
 * provider will not take, a payload it cannot parse), and those are treated
 * like a refusal. Anything that is not an HTTP error at all — a refusal, a
 * truncation, an unparseable body, all thrown by `ask` — is about the batch.
 *
 * Checked after the SDK's own retries (`openaiMaxRetries`) have run out, so
 * reaching here is a sustained failure and not one dropped packet.
 */
export function isProviderFailure(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionError) return true;
  if (!(error instanceof OpenAI.APIError)) return false;
  const status = error.status;
  if (status === undefined) return false;
  return status !== 400 && status !== 422;
}

export interface TranslationRequest {
  /** Same `ref` the English pass used, so a caller can line the two up. */
  ref: string;
  category: string;
  rawText: string;
  /** The accepted English copy. Only items that got some are ever translated. */
  english: ItemCopy;
}

/** How long a field may be, and which language's filter it is judged against. */
interface Limits {
  title: number;
  conditionLine: number;
  locale: LeakLocale;
}

const ENGLISH_LIMITS: Limits = {
  title: MAX_TITLE_LENGTH,
  conditionLine: MAX_CONDITION_LENGTH,
  locale: 'en',
};

/**
 * Writes the words a player reads.
 *
 * Deliberately knows nothing about the database or the filesystem: it takes
 * descriptions and returns prose, which is what makes it testable without
 * either. `ItemCopyProcessor` decides what to do when it returns nothing.
 */
@Injectable()
export class ItemCopywriter {
  private readonly logger = new Logger(ItemCopywriter.name);
  private readonly config: CopywritingConfig;
  private client: OpenAI | null = null;

  constructor(config: ConfigService) {
    this.config = config.getOrThrow<CopywritingConfig>('copywriting');
  }

  get available(): boolean {
    return Boolean(this.config.openaiApiKey);
  }

  /**
   * Copy for each request, keyed by `ref`.
   *
   * An item the model refused, truncated, or leaked on is simply absent from
   * the map, and the caller falls back to what the portal was given. A missing
   * description is a worse item; a failed pass over one refusal is a worse
   * outage.
   *
   * The one thing that does throw is the provider being unreachable — see
   * `CopywriterUnavailableError`. The batches after it are not attempted: they
   * would fail the same way, each after its own timeout and retries.
   */
  async write(requests: CopyRequest[]): Promise<Map<string, ItemCopy>> {
    const written = new Map<string, ItemCopy>();
    const settled = new Set<string>();
    if (requests.length === 0 || !this.available) return written;

    for (let start = 0; start < requests.length; start += BATCH_SIZE) {
      const batch = requests.slice(start, start + BATCH_SIZE);
      try {
        for (const [ref, copy] of await this.writeBatch(batch)) {
          written.set(ref, copy);
        }
        for (const item of batch) settled.add(item.ref);
      } catch (error) {
        if (isProviderFailure(error)) {
          throw new CopywriterUnavailableError(written, settled, error);
        }
        for (const item of batch) settled.add(item.ref);
        const why = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Copy for ${batch.length} item(s) failed (${why}) — they keep the text their filenames gave`,
        );
      }
    }

    return written;
  }

  /**
   * `requests` rendered into `locale`, keyed by `ref`.
   *
   * A separate request per language rather than one call returning all of them.
   * The combined shape is fewer round trips and was the obvious first design,
   * but this service is built so that "one refusal costs little" — `BATCH_SIZE`
   * is kept small for that reason — and a nested reply makes one refusal cost
   * the whole batch times every language at once. Here a failed Italian batch leaves
   * Italian falling back to English and touches nothing else, which is the same
   * bargain the English pass already makes with the filename.
   *
   * Refuses a language it has no leak patterns for. The filter is the only
   * thing behind the prompt, and generating into a language nothing can check
   * is worse than not offering that language: the leak would ship, and it would
   * ship in a log line nobody on the team can read.
   */
  async translate(
    locale: CopyLocale,
    requests: TranslationRequest[],
  ): Promise<Map<string, ItemCopy>> {
    const written = new Map<string, ItemCopy>();
    if (requests.length === 0 || !this.available) return written;

    // Widened on purpose. `CopyLocale` is a subset of the languages the filter
    // knows, so the compiler proves this branch unreachable and narrows the
    // parameter to `never` inside it — but the proof only holds while the two
    // lists agree, and this is the guard for the commit where they stop
    // agreeing. `COPY_LOCALES` is what a locale is added to; nothing forces the
    // patterns to be added with it except the spec and this.
    const language: string = locale;
    if (!hasLeakPatterns(language)) {
      this.logger.error(
        `No leak patterns for "${language}" — refusing to write copy that nothing can check`,
      );
      return written;
    }

    const limits: Limits = {
      title: MAX_TRANSLATED_TITLE_LENGTH,
      conditionLine: MAX_TRANSLATED_CONDITION_LENGTH,
      locale,
    };

    for (let start = 0; start < requests.length; start += BATCH_SIZE) {
      const batch = requests.slice(start, start + BATCH_SIZE);
      try {
        for (const [ref, copy] of await this.translateBatch(
          locale,
          batch,
          limits,
        )) {
          written.set(ref, copy);
        }
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        // Not thrown, unlike `write`. The English is already committed and the
        // item's flag already cleared, so there is nothing for a retry to find;
        // a translation lost to an outage falls back to English like a refused
        // one, and Rewrite in the portal is how it is asked for again. What an
        // outage does change is whether the rest of this language is worth
        // attempting — each batch would wait out its own timeout to fail.
        if (isProviderFailure(error)) {
          const left = requests.length - start;
          this.logger.error(
            `${locale} copy stopped: OpenAI unavailable (${why}) — ${left} item(s) fall back to English`,
          );
          break;
        }
        this.logger.warn(
          `${locale} copy for ${batch.length} item(s) failed (${why}) — they fall back to English`,
        );
      }
    }

    return written;
  }

  private async translateBatch(
    locale: CopyLocale,
    batch: TranslationRequest[],
    limits: Limits,
  ): Promise<Map<string, ItemCopy>> {
    const parsed = await this.ask(
      translationSystem(locale),
      [
        `Write the ${LANGUAGE_NAMES[locale]} title and description for each item below. Return every item, keyed by its \`ref\`.`,
        '',
        '`englishTitle` and `englishDescription` are the accepted English copy for the same object; `filenameText` is the raw text they were written from, which sometimes carries a model year or a card grade the English dropped.',
        '',
        JSON.stringify(
          batch.map((item) => ({
            ref: item.ref,
            category: item.category,
            filenameText: item.rawText,
            englishTitle: item.english.title,
            englishDescription: item.english.conditionLine,
          })),
          null,
          2,
        ),
      ].join('\n'),
    );

    const accepted = new Map<string, ItemCopy>();
    for (const row of parsed.items) {
      const copy = this.vet(row, limits);
      if (copy) accepted.set(row.ref, copy);
    }
    return accepted;
  }

  private async writeBatch(
    batch: CopyRequest[],
  ): Promise<Map<string, ItemCopy>> {
    const parsed = await this.ask(SYSTEM, [
      { role: 'user', content: describeBatch(batch) },
    ]);

    const accepted = new Map<string, ItemCopy>();
    for (const row of parsed.items) {
      const copy = this.vet(row, ENGLISH_LIMITS);
      if (copy) accepted.set(row.ref, copy);
    }
    return accepted;
  }

  /**
   * One request, with everything that is not copy already turned into a throw.
   *
   * Shared by the English pass and the translation pass, which differ only in
   * their instructions and their input — the reply shape, the truncation check,
   * the refusal check and the parse are the same question either way, and two
   * copies of them would be two places for a refusal to stop being noticed.
   *
   * Every failure here is a throw rather than an empty map, because the callers
   * turn a throw into "this batch keeps what it had" and log why. A silent
   * empty result would be indistinguishable from a batch the model vetted away.
   */
  private async ask(
    instructions: string,
    input: string | ResponseInput,
  ): Promise<z.infer<typeof CopyBatch>> {
    // Bounded rather than left on the SDK's defaults — see the note on
    // `openaiTimeoutMs`. The retries are the SDK's own, declared here so the
    // worst case a caller is signing up for is one multiplication away.
    const client = (this.client ??= new OpenAI({
      apiKey: this.config.openaiApiKey,
      timeout: this.config.openaiTimeoutMs,
      maxRetries: this.config.openaiMaxRetries,
    }));

    // `parse` rather than `create`: the same request, with the reply run back
    // through the schema on the way out. A malformed or truncated body throws
    // here instead of reaching `vet` as an unchecked cast.
    const response = await client.responses.parse({
      model: this.config.openaiModel,
      instructions,
      input,
      max_output_tokens: 4096,
      text: { format: zodTextFormat(CopyBatch, 'item_copy') },
    });

    if (response.status === 'incomplete') {
      throw new Error(
        `the response was cut short (${response.incomplete_details?.reason ?? 'no reason given'})`,
      );
    }

    const refusal = response.output
      .flatMap((item) => (item.type === 'message' ? item.content : []))
      .find((block) => block.type === 'refusal');
    if (refusal && refusal.type === 'refusal') {
      throw new Error(`the model declined this batch: ${refusal.refusal}`);
    }

    // Null when the model produced no parseable message at all — a refusal is
    // caught above, so reaching this means something stranger.
    if (!response.output_parsed) {
      throw new Error('the response carried no parseable copy');
    }

    return response.output_parsed;
  }

  /**
   * Both fields must be non-empty, in bounds, and free of anything that hands
   * the player the answer. A field that fails is not repaired — the whole item
   * is dropped, because a title accepted alongside a rejected description would
   * leave a row half-written by the model and half by the filename.
   *
   * Kept out of the schema on purpose. These are per-item policy, and the batch
   * is several items: expressing them as `z.string().max(120)` would fail the
   * parse and cost the others their copy over one long title. This also
   * keeps the reason in the log, which "invalid response" would not.
   *
   * The schema does guarantee the three fields exist and are strings, so this
   * only has to judge them.
   */
  private vet(row: CopyRow, limits: Limits): ItemCopy | null {
    const title = row.title.trim();
    const conditionLine = row.conditionLine.trim();
    const where =
      limits.locale === 'en' ? row.ref : `${row.ref} (${limits.locale})`;

    if (!title || !conditionLine) return null;

    if (title.length > limits.title) {
      this.logger.warn(
        `Rejected copy for ${where}: title is ${title.length} chars, over ${limits.title}`,
      );
      return null;
    }
    if (conditionLine.length > limits.conditionLine) {
      this.logger.warn(
        `Rejected copy for ${where}: description is ${conditionLine.length} chars, over ${limits.conditionLine}`,
      );
      return null;
    }

    for (const [field, text] of [
      ['title', title],
      ['description', conditionLine],
    ] as const) {
      // In the language the text is actually in. The English list is no filter
      // at all for Spanish, Portuguese or Italian — `raro`, `prezioso` and
      // `de colección` all pass it while handing the player the answer.
      const leak = findPriceLeak(text, limits.locale);
      if (leak) {
        this.logger.warn(
          `Rejected copy for ${where}: ${field} carries ${leak} — "${text}"`,
        );
        return null;
      }
    }

    return { title, conditionLine };
  }
}

/**
 * The per-batch half of the brief, separated from the class so its two real
 * rules can be pinned by a test: an item nobody recorded a condition for is
 * sent without the key rather than with an empty one, and an item's photograph
 * arrives labelled with the `ref` it belongs to.
 *
 * The labelling is what makes a batch safe. Four items and four pictures in one
 * request is four chances to describe the wrong object, and nothing inside an
 * image block says which row it came with — so each is introduced by name, in
 * the text immediately before it.
 */
export function describeBatch(batch: CopyRequest[]): ResponseInputContent[] {
  const rows = batch.map((item) => ({
    ref: item.ref,
    category: item.category,
    filenameText: item.rawText,
    // Omitted rather than sent empty, for the same reason the next line
    // calls it factual: a key that is present is a claim about the object,
    // and `""` would be a claim that there is nothing to say. Most items
    // arrive without one — the portal does not ask, and a filename only
    // carries this when it ends in a year or a grade.
    ...(item.knownCondition ? { knownCondition: item.knownCondition } : {}),
    ...(item.taken?.length ? { titlesAlreadyUsed: item.taken } : {}),
  }));

  const withPhotos = batch.filter((item) => item.photo);

  const brief = [
    'Write a title and a description for each item below. Return every item, keyed by its `ref`.',
    '',
    '`filenameText` is the raw description someone typed. Where `knownCondition` is present it is what that text recorded — a model year, or a grade a card was given. That much is factual, so carry it into the description rather than discarding it.',
    '',
    'Most items have no `knownCondition`, and that means nothing is known about the state of the object. Write the description without it. Do not reach for a word like "used" to stand in.',
    '',
    'Where `titlesAlreadyUsed` is present, your title must differ from every entry in it — those name other objects in the same category.',
    '',
    JSON.stringify(rows, null, 2),
    ...(withPhotos.length
      ? [
          '',
          'The photographs follow, each introduced by the `ref` it belongs to. Use each one only for its own item. An item whose photograph is not here has none — write it from its text, and do not guess at what a picture would have shown.',
        ]
      : []),
  ].join('\n');

  const content: ResponseInputContent[] = [{ type: 'input_text', text: brief }];
  for (const item of withPhotos) {
    content.push({
      type: 'input_text',
      text: `The photograph for ref ${JSON.stringify(item.ref)}:`,
    });
    content.push({
      type: 'input_image',
      image_url: item.photo as string,
      detail: 'auto',
    });
  }
  return content;
}
