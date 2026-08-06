import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

import { ImportConfig } from 'src/config/configuration';

/** The columns these have to fit. `conditionLine` is varchar(160). */
export const MAX_TITLE_LENGTH = 120;
export const MAX_CONDITION_LENGTH = 150;

/** Items per request. Small enough that one refusal costs little. */
const BATCH_SIZE = 8;

/**
 * What a description must never contain.
 *
 * The model is never shown a price, so a leak here is the model reasoning from
 * what it knows about the object rather than repeating something we told it —
 * "one of the most valuable cards ever printed" is a giveaway even though no
 * number appears in it. Prompting alone does not reliably stop that, so the
 * output is also filtered.
 *
 * Applied to the title as well as the description. The title used to be
 * deterministic and could not leak; now that a model writes it, "Rare Black
 * Lotus" is exactly as much of a giveaway as it would be in the line below.
 */
const LEAK_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/[$€£¥]\s?\d/u, 'a currency amount'],
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
  [/\b(low|high|top|entry)[- ]end\b/i, 'a market-tier claim'],
  [/\b(luxury|exclusive|flagship|halo)\b/i, 'a market-tier claim'],
];

export function findPriceLeak(text: string): string | null {
  for (const [pattern, why] of LEAK_PATTERNS) {
    const hit = pattern.exec(text);
    if (hit) return `${why} ("${hit[0]}")`;
  }
  return null;
}

const SYSTEM = `You write the title and the one-line description shown under an item's photograph in a price-guessing game.

The player sees your title, the photograph, your line, and a slider. They then guess what the object is worth. Your words are the only prose they get, so they have to help them reason — and they must never tell them the answer.

You are given the raw text of the item's filename, as typed by whoever added it. It is terse, sometimes misspelled, and sometimes has the model year or a card grade stuck on the end.

TITLE: name the object as a catalogue would. Correct the spelling and capitalisation of marques, models and proper nouns. Keep it specific — the model, not the category. Do not put the year or the condition in the title. Under 120 characters, no trailing full stop.

DESCRIPTION: write what the object IS — its specifics, materials, mechanism, era, configuration, condition, and the concrete details an informed person would notice. Facts a knowledgeable owner would state plainly.

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

Bad (all leak the answer):
- "A rare and highly sought-after example" — desirability claim
- "One of the most valuable cards ever printed" — value judgement
- "Recently sold at auction for a record sum" — market reference`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          title: { type: 'string' },
          conditionLine: { type: 'string' },
        },
        required: ['ref', 'title', 'conditionLine'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

export interface CopyRequest {
  /** Opaque key the model echoes back, so a reordered reply still matches up. */
  ref: string;
  category: string;
  rawText: string;
  knownCondition: string;
  /** Titles already taken in this category, which this one must not repeat. */
  taken?: string[];
}

export interface ItemCopy {
  title: string;
  conditionLine: string;
}

/**
 * Writes the words a player reads.
 *
 * Deliberately knows nothing about the database or the filesystem: it takes
 * descriptions and returns prose, which is what makes it testable without
 * either. `CatalogImportService` decides what to do when it returns nothing.
 */
@Injectable()
export class ItemCopywriter {
  private readonly logger = new Logger(ItemCopywriter.name);
  private readonly config: ImportConfig;
  private client: OpenAI | null = null;

  constructor(config: ConfigService) {
    this.config = config.getOrThrow<ImportConfig>('import');
  }

  get available(): boolean {
    return Boolean(this.config.openaiApiKey);
  }

  /**
   * Copy for each request, keyed by `ref`.
   *
   * Never throws and never partially fails the caller: an item the model
   * refused, truncated, or leaked on is simply absent from the map, and the
   * import falls back to what the filename said. A missing description is a
   * worse item; a failed deploy is a worse outage.
   */
  async write(requests: CopyRequest[]): Promise<Map<string, ItemCopy>> {
    const written = new Map<string, ItemCopy>();
    if (requests.length === 0 || !this.available) return written;

    for (let start = 0; start < requests.length; start += BATCH_SIZE) {
      const batch = requests.slice(start, start + BATCH_SIZE);
      try {
        for (const [ref, copy] of await this.writeBatch(batch)) {
          written.set(ref, copy);
        }
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Copy for ${batch.length} item(s) failed (${why}) — they keep the text their filenames gave`,
        );
      }
    }

    return written;
  }

  private async writeBatch(
    batch: CopyRequest[],
  ): Promise<Map<string, ItemCopy>> {
    const client = (this.client ??= new OpenAI({
      apiKey: this.config.openaiApiKey,
    }));

    const response = await client.responses.create({
      model: this.config.openaiModel,
      instructions: SYSTEM,
      input: this.describe(batch),
      max_output_tokens: 4096,
      text: {
        format: {
          type: 'json_schema',
          name: 'item_copy',
          strict: true,
          schema: RESPONSE_SCHEMA,
        },
      },
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

    const parsed = JSON.parse(response.output_text) as {
      items?: { ref: string; title: string; conditionLine: string }[];
    };

    const accepted = new Map<string, ItemCopy>();
    for (const row of parsed.items ?? []) {
      const copy = this.vet(row);
      if (copy) accepted.set(row.ref, copy);
    }
    return accepted;
  }

  /**
   * Both fields must be present, in bounds, and free of anything that hands the
   * player the answer. A field that fails is not repaired — the whole item is
   * dropped, because a title accepted alongside a rejected description would
   * leave a row half-written by the model and half by the filename.
   */
  private vet(row: {
    ref: string;
    title: string;
    conditionLine: string;
  }): ItemCopy | null {
    const title = row.title?.trim() ?? '';
    const conditionLine = row.conditionLine?.trim() ?? '';

    if (!title || !conditionLine) return null;

    if (title.length > MAX_TITLE_LENGTH) {
      this.logger.warn(
        `Rejected copy for ${row.ref}: title is ${title.length} chars, over ${MAX_TITLE_LENGTH}`,
      );
      return null;
    }
    if (conditionLine.length > MAX_CONDITION_LENGTH) {
      this.logger.warn(
        `Rejected copy for ${row.ref}: description is ${conditionLine.length} chars, over ${MAX_CONDITION_LENGTH}`,
      );
      return null;
    }

    for (const [field, text] of [
      ['title', title],
      ['description', conditionLine],
    ] as const) {
      const leak = findPriceLeak(text);
      if (leak) {
        this.logger.warn(
          `Rejected copy for ${row.ref}: ${field} carries ${leak} — "${text}"`,
        );
        return null;
      }
    }

    return { title, conditionLine };
  }

  private describe(batch: CopyRequest[]): string {
    const rows = batch.map((item) => ({
      ref: item.ref,
      category: item.category,
      filenameText: item.rawText,
      knownCondition: item.knownCondition,
      ...(item.taken?.length ? { titlesAlreadyUsed: item.taken } : {}),
    }));

    return [
      'Write a title and a description for each item below. Return every item, keyed by its `ref`.',
      '',
      '`filenameText` is the raw description someone typed. `knownCondition` is what it recorded about condition — usually a model year or a card grade. That is factual, so carry it into the description rather than discarding it.',
      '',
      'Where `titlesAlreadyUsed` is present, your title must differ from every entry in it — those name other objects in the same category.',
      '',
      JSON.stringify(rows, null, 2),
    ].join('\n');
  }
}
