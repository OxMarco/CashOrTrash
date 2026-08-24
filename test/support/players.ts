import { Api } from './api-client';

export interface Player {
  api: Api;
  userId: number;
  deviceId: string;
  accessToken: string;
  username: string | null;
}

/** The `sub` claim, without pulling a JWT library into the test tree. */
const subjectOf = (accessToken: string): number => {
  const [, payload] = accessToken.split('.');
  const decoded = JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8'),
  ) as { sub: string };
  return Number(decoded.sub);
};

/**
 * Registers a device and, when given a name, claims it. Returns a client
 * already carrying the access token, so specs read as "maria does X".
 */
export async function registerPlayer(
  api: Api,
  deviceId: string,
  username?: string,
): Promise<Player> {
  const auth = await api.post('/v1/auth/anonymous', { deviceId });
  if (auth.status !== 200) {
    throw new Error(`auth failed (${auth.status}): ${auth.raw}`);
  }

  const authed = api.as(auth.body.accessToken);
  let claimed: string | null = auth.body.username ?? null;

  if (username) {
    const response = await authed.post('/v1/me/username', { username });
    if (response.status !== 200) {
      throw new Error(`claim failed (${response.status}): ${response.raw}`);
    }
    claimed = response.body.username;
  }

  return {
    api: authed,
    userId: subjectOf(auth.body.accessToken),
    deviceId,
    accessToken: auth.body.accessToken,
    username: claimed,
  };
}

export interface PlayedRound {
  current: any;
  reveal: any;
}

/**
 * Plays one round using the server's own suggested range, which is guaranteed
 * legal — snapped to the increment and inside the slider. Whether it *hits* is
 * incidental and no spec should depend on it; the scoring maths is proven in
 * the unit suite, and these tests are about the loop around it.
 */
export async function playRound(
  api: Api,
  sessionId: string,
  roundIndex: number,
  range?: { loCents: number; hiCents: number },
): Promise<PlayedRound> {
  const current = await api.get(`/v1/sessions/${sessionId}/current`);
  if (current.status !== 200) {
    throw new Error(`current failed (${current.status}): ${current.raw}`);
  }

  const bet = range ?? {
    loCents: current.body.suggestedLoCents,
    hiCents: current.body.suggestedHiCents,
  };

  const reveal = await api.post(
    `/v1/sessions/${sessionId}/rounds/${roundIndex}/bet`,
    bet,
  );
  if (reveal.status !== 200) {
    throw new Error(`bet failed (${reveal.status}): ${reveal.raw}`);
  }

  return { current: current.body, reveal: reveal.body };
}

/** Starts today's daily and plays it to completion. */
export async function playDaily(api: Api): Promise<{
  sessionId: string;
  rounds: PlayedRound[];
  totalScore: number;
}> {
  const session = await api.post('/v1/sessions', { mode: 'daily' });
  if (session.status !== 201 && session.status !== 200) {
    throw new Error(`session failed (${session.status}): ${session.raw}`);
  }

  const sessionId = session.body.id as string;
  const rounds: PlayedRound[] = [];

  for (let index = 0; index < session.body.roundCount; index++) {
    rounds.push(await playRound(api, sessionId, index));
  }

  return {
    sessionId,
    rounds,
    totalScore: rounds[rounds.length - 1].reveal.totalScore,
  };
}

/**
 * A range that cannot contain the price, for specs that need a guaranteed
 * miss: the bottom increment of the slider, which the seeded catalogue always
 * places well below the true price.
 */
export const lowestLegalRange = (
  current: any,
): {
  loCents: number;
  hiCents: number;
} => ({
  loCents: current.sliderMinCents,
  hiCents: current.sliderMinCents + current.incrementCents,
});
