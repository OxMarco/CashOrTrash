import { Injectable } from '@nestjs/common';
import {
  englishDataset,
  englishRecommendedTransformers,
  RegExpMatcher,
} from 'obscenity';

import {
  ADDITIONAL_BLOCKED_SUBSTRINGS,
  RESERVED_USERNAMES,
} from './constants/reserved-usernames';

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 16;
export const USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.]{2,15}$/;

export type UsernameRejection =
  'too_short' | 'too_long' | 'invalid_characters' | 'reserved' | 'profane';

/**
 * Stable machine-readable slugs: the `type` of the problem document on a
 * rejected claim, and `code` on the availability probe.
 *
 * The client picks its own copy from these. `reason` is prose for a human
 * reading a log — rewording it must not change what a shipped app does with
 * the answer, and a client that switches on the copy breaks when it does.
 */
export const USERNAME_INVALID = 'username-invalid';
export const USERNAME_NOT_ALLOWED = 'username-not-allowed';
export const USERNAME_TAKEN = 'username-taken';

export type UsernameProblemCode =
  typeof USERNAME_INVALID | typeof USERNAME_NOT_ALLOWED | typeof USERNAME_TAKEN;

export interface UsernameCheck {
  ok: boolean;
  normalised: string;
  reason?: UsernameRejection;
}

/**
 * `obscenity` rather than a word list of our own: it ships the English dataset
 * together with the transformers that see through leetspeak, confusables and
 * repeated letters, so `fvck`, `sh1t` and `n1gger` are caught by the same rule
 * that catches the plain spelling — and `classiccars`, `bassmaster` and
 * `assistant` are not, which a naive substring list gets wrong.
 *
 * Built once at module load: assembling the matcher compiles every pattern,
 * and this sits behind a per-keystroke endpoint.
 */
const profanity = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

/**
 * Pure validation, no I/O — availability against the database is the caller's
 * job. Split this way so the same rules run on the availability probe and on
 * the claim without a round trip on the obviously-invalid cases.
 */
@Injectable()
export class UsernameService {
  /** Trim and case-fold. Storage is citext, so this is for comparison only. */
  normalise(raw: string): string {
    return raw.trim().toLowerCase();
  }

  check(raw: string): UsernameCheck {
    const normalised = this.normalise(raw);

    if (normalised.length < USERNAME_MIN) {
      return { ok: false, normalised, reason: 'too_short' };
    }
    if (normalised.length > USERNAME_MAX) {
      return { ok: false, normalised, reason: 'too_long' };
    }
    if (!USERNAME_PATTERN.test(normalised)) {
      return { ok: false, normalised, reason: 'invalid_characters' };
    }
    if (RESERVED_USERNAMES.has(normalised)) {
      return { ok: false, normalised, reason: 'reserved' };
    }
    if (this.isProfane(normalised)) {
      return { ok: false, normalised, reason: 'profane' };
    }

    return { ok: true, normalised };
  }

  /** Player-facing copy for the availability field on the onboarding screen. */
  describe(reason: UsernameRejection): string {
    switch (reason) {
      case 'too_short':
        return `At least ${USERNAME_MIN} characters`;
      case 'too_long':
        return `At most ${USERNAME_MAX} characters`;
      case 'invalid_characters':
        return 'Letters, numbers, dots and underscores; must start with a letter';
      case 'reserved':
      case 'profane':
        return 'That name is not available';
    }
  }

  /**
   * Which shape of "no" this is.
   *
   * A format problem is the client's to describe — it knows the rules and can
   * point at the field. Reserved and profane collapse into one flat answer on
   * purpose: telling someone *which* filter they tripped is a hint about how
   * to get the next variation past it.
   */
  problemCode(reason: UsernameRejection): UsernameProblemCode {
    return reason === 'reserved' || reason === 'profane'
      ? USERNAME_NOT_ALLOWED
      : USERNAME_INVALID;
  }

  /**
   * Separators are collapsed before matching. The transformers see through
   * substitutions inside a word, but not through `f.u.c.k` — the dots break the
   * word boundaries the dataset's patterns are anchored to, so the raw handle
   * and the collapsed one are both checked.
   */
  private isProfane(normalised: string): boolean {
    const collapsed = normalised.replace(/[._]/g, '');

    if (profanity.hasMatch(normalised) || profanity.hasMatch(collapsed)) {
      return true;
    }

    return ADDITIONAL_BLOCKED_SUBSTRINGS.some((word) =>
      collapsed.includes(word),
    );
  }
}
