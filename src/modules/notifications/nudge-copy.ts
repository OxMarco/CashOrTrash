import {
  DEFAULT_LANGUAGE,
  Language,
  SUPPORTED_LANGUAGES,
} from '../catalog/language.constants';

/**
 * The words a nudge arrives in.
 *
 * Hand-written rather than generated, and hand-written rather than shared with
 * the app's catalogue. There are eight strings, they change roughly never, and
 * the alternative — a build step that lifts them out of the client bundle — is
 * more machinery than the strings are worth.
 *
 * Whose language it is: the device's, recorded on the push token when the app
 * registers it. That is the only way to know at send time, because this runs
 * hourly against tokens whose owners' apps are closed.
 */
export type NudgeKind = 'streak_at_risk' | 'daily_ready';

export interface NudgeMessage {
  title: string;
  body: string;
}

type Copy = {
  /** `{days}` is the streak the player is about to lose. */
  streak_at_risk: NudgeMessage;
  daily_ready: NudgeMessage;
};

const COPY: Record<Language, Copy> = {
  en: {
    streak_at_risk: {
      title: 'Your {days}-day streak is at risk',
      body: 'Five items, two minutes. Keep it alive.',
    },
    daily_ready: {
      title: 'Today’s five finds are up',
      body: 'Same items for everyone. How sharp is your eye?',
    },
  },
  es: {
    streak_at_risk: {
      title: 'Tu racha de {days} días está en peligro',
      body: 'Cinco objetos, dos minutos. Mantenla viva.',
    },
    daily_ready: {
      title: 'Ya están los cinco hallazgos de hoy',
      body: 'Los mismos objetos para todos. ¿Qué tal tienes el ojo?',
    },
  },
  pt: {
    streak_at_risk: {
      title: 'A tua série de {days} dias está em risco',
      body: 'Cinco objetos, dois minutos. Mantém-na viva.',
    },
    daily_ready: {
      title: 'Já saíram os cinco achados de hoje',
      body: 'Os mesmos objetos para todos. Que tal o teu olho?',
    },
  },
  it: {
    streak_at_risk: {
      title: 'La tua serie di {days} giorni è a rischio',
      body: 'Cinque oggetti, due minuti. Tienila viva.',
    },
    daily_ready: {
      title: 'Ci sono i cinque pezzi di oggi',
      body: 'Gli stessi oggetti per tutti. Quanto ce l’hai buono l’occhio?',
    },
  },
};

function isSupported(locale: string): locale is Language {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(locale);
}

/**
 * The nudge for `kind` in `locale`, falling back to English.
 *
 * The fallback is load-bearing rather than defensive: `push_token.locale` is a
 * plain varchar and every row that predates the column carries the default, so
 * a value this file has never heard of is a normal thing to be handed — from an
 * older client, or from a language the app ships before the server does.
 */
export function nudgeCopy(
  kind: NudgeKind,
  locale: string,
  vars: { days?: number } = {},
): NudgeMessage {
  const copy = COPY[isSupported(locale) ? locale : DEFAULT_LANGUAGE][kind];
  const days = String(vars.days ?? 0);
  return {
    title: copy.title.replace('{days}', days),
    body: copy.body.replace('{days}', days),
  };
}
