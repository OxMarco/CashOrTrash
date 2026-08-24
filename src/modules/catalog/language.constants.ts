/**
 * The languages a response can be asked for.
 *
 * Mirrors the app's `SUPPORTED_LOCALES`. English is the canonical copy stored
 * on `item` itself and is what everything else falls back to, which is why it
 * is in this list but never in `item_copy`.
 */
export const SUPPORTED_LANGUAGES = ['en', 'es', 'pt', 'it'] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = 'en';
