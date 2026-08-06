import { io, Socket } from 'socket.io-client';

import {
  MATCH_EVENTS,
  MatchesGateway,
} from '../src/modules/matches/matches.gateway';
import { playRound, registerPlayer } from './support/players';
import { createTestApp, resetGameplayState, TestApp } from './support/test-app';

/**
 * Phase 6 exit criterion: two clients on *different replicas* see each other's
 * presence and bets. That is the whole reason the socket adapter is
 * Redis-backed — with the in-memory default, both halves of a match would work
 * perfectly in a single-process test and go silent the moment a load balancer
 * put the two players on different pods.
 *
 * So this suite boots two applications against one Postgres and one Redis,
 * connects each player to their own, and asserts across the gap.
 */
describe('head-to-head across replicas', () => {
  let replicaA: TestApp;
  let replicaB: TestApp;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    // Sequentially: two Nest apps racing to run the same bootstrap hooks is a
    // fight over Redis keys that tells us nothing.
    replicaA = await createTestApp();
    replicaB = await createTestApp();
  });

  beforeEach(async () => {
    await resetGameplayState(replicaA);
  });

  afterEach(() => {
    while (sockets.length) sockets.pop()?.disconnect();
  });

  afterAll(async () => {
    await replicaA?.close();
    await replicaB?.close();
  });

  /** Connects and authenticates without joining any match room. */
  const openSocket = async (
    baseUrl: string,
    token: string,
  ): Promise<Socket> => {
    const socket = io(`${baseUrl}/matches`, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(socket);

    await new Promise<void>((resolve, reject) => {
      // Cleared on both paths: a pending timer outlives the test and keeps the
      // whole run from exiting.
      const timer = setTimeout(
        () => reject(new Error('socket connect timed out')),
        10_000,
      );
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    return socket;
  };

  /** Connects to a replica's match namespace and joins the match room. */
  const connect = async (
    baseUrl: string,
    token: string,
    matchId: string,
  ): Promise<Socket> => {
    const socket = await openSocket(baseUrl, token);

    await socket.emitWithAck('joinMatch', { matchId });
    return socket;
  };

  /** Resolves on the next occurrence of `event`, or rejects on timeout. */
  const nextEvent = <T = any>(
    socket: Socket,
    event: string,
    timeoutMs = 10_000,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for "${event}"`)),
        timeoutMs,
      );
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  describe('setting a match up', () => {
    it('allocates an invite code and a deep link', async () => {
      const host = await registerPlayer(replicaA.api, 'h2h-host-0001', 'hosty');

      const match = await host.api.post('/v1/matches', {
        themeSlug: 'vintage-finds',
      });

      expect(match.status).toBe(201);
      expect(match.body.inviteCode).toMatch(/^[A-Z2-9]{6}$/);
      expect(match.body.deepLink).toBe(
        `cashortrash://match/${match.body.inviteCode}`,
      );
      expect(match.body.status).toBe('pending');
      expect(match.body.host.username).toBe('hosty');
      expect(match.body.guest).toBeNull();
    });

    it('refuses to let the host join their own match', async () => {
      const host = await registerPlayer(
        replicaA.api,
        'h2h-host-0002',
        'lonely',
      );
      const match = await host.api.post('/v1/matches', {
        themeSlug: 'vintage-finds',
      });

      const response = await host.api.post('/v1/matches/join', {
        inviteCode: match.body.inviteCode,
      });

      expect(response.status).toBe(400);
    });

    it('rejects an unknown invite code', async () => {
      const player = await registerPlayer(replicaA.api, 'h2h-host-0003');

      const response = await player.api.post('/v1/matches/join', {
        inviteCode: 'ZZZZZZ',
      });

      // A mistyped code is bad input, not a missing resource — the client
      // shows "check that code", it does not navigate anywhere.
      expect(response.status).toBe(400);
    });

    it('turns a match active when the guest joins from another replica', async () => {
      const host = await registerPlayer(replicaA.api, 'h2h-host-0004', 'hosta');
      const guest = await registerPlayer(
        replicaB.api,
        'h2h-guest-0004',
        'guestb',
      );

      const match = await host.api.post('/v1/matches', {
        themeSlug: 'vintage-finds',
      });
      const joined = await guest.api.post('/v1/matches/join', {
        inviteCode: match.body.inviteCode,
      });

      expect(joined.status).toBe(200);
      expect(joined.body.status).toBe('active');
      expect(joined.body.guest.username).toBe('guestb');

      // A third player finds it full.
      const gatecrasher = await registerPlayer(replicaB.api, 'h2h-third-0004');
      const rejected = await gatecrasher.api.post('/v1/matches/join', {
        inviteCode: match.body.inviteCode,
      });
      expect(rejected.status).toBe(409);
    });
  });

  describe('playing across two replicas', () => {
    it('deals both players the identical ordered set', async () => {
      const host = await registerPlayer(
        replicaA.api,
        'h2h-host-0005',
        'sameitemsa',
      );
      const guest = await registerPlayer(
        replicaB.api,
        'h2h-guest-0005',
        'sameitemsb',
      );

      const match = await host.api.post('/v1/matches', {
        themeSlug: 'vintage-finds',
      });
      await guest.api.post('/v1/matches/join', {
        inviteCode: match.body.inviteCode,
      });

      const [hostSession, guestSession] = await Promise.all([
        host.api.post('/v1/sessions', {
          mode: 'h2h',
          inviteCode: match.body.inviteCode,
        }),
        guest.api.post('/v1/sessions', {
          mode: 'h2h',
          inviteCode: match.body.inviteCode,
        }),
      ]);

      const [hostItems, guestItems] = await Promise.all([
        sessionItemIds(replicaA, hostSession.body.id),
        sessionItemIds(replicaA, guestSession.body.id),
      ]);

      expect(hostItems).toEqual(guestItems);
      expect(hostSession.body.matchId).toBe(match.body.id);
    });

    it('creates only one session when a player double-taps an H2H match', async () => {
      const host = await registerPlayer(
        replicaA.api,
        'h2h-host-concurrent',
        'rapidhost',
      );
      const guest = await registerPlayer(
        replicaB.api,
        'h2h-guest-concurrent',
        'rapidguest',
      );
      const match = await host.api.post('/v1/matches', {
        themeSlug: 'vintage-finds',
      });
      await guest.api.post('/v1/matches/join', {
        inviteCode: match.body.inviteCode,
      });

      const requests = await Promise.all([
        host.api.post('/v1/sessions', {
          mode: 'h2h',
          inviteCode: match.body.inviteCode,
        }),
        replicaB.api.as(host.accessToken).post('/v1/sessions', {
          mode: 'h2h',
          inviteCode: match.body.inviteCode,
        }),
        host.api.post('/v1/sessions', {
          mode: 'h2h',
          inviteCode: match.body.inviteCode,
        }),
      ]);

      expect(requests.map((response) => response.status)).toEqual([
        201, 201, 201,
      ]);
      expect(new Set(requests.map((response) => response.body.id)).size).toBe(
        1,
      );

      const [row] = await replicaA.dataSource.query(
        `SELECT COUNT(*)::int AS count FROM game_session
         WHERE "userId" = $1 AND "matchId" = $2`,
        [host.userId, match.body.id],
      );
      expect(row.count).toBe(1);
    });

    /**
     * The criterion itself: the host bets on replica A and the guest, holding
     * a socket to replica B, is told about it. Nothing but the Redis adapter
     * carries that message.
     */
    it('delivers the opponent’s bet to a socket on the other replica', async () => {
      const host = await registerPlayer(
        replicaA.api,
        'h2h-host-0006',
        'crossa',
      );
      const guest = await registerPlayer(
        replicaB.api,
        'h2h-guest-0006',
        'crossb',
      );

      const match = await host.api.post('/v1/matches', {
        themeSlug: 'vintage-finds',
      });
      await guest.api.post('/v1/matches/join', {
        inviteCode: match.body.inviteCode,
      });

      const hostSession = await host.api.post('/v1/sessions', {
        mode: 'h2h',
        inviteCode: match.body.inviteCode,
      });
      const guestSession = await guest.api.post('/v1/sessions', {
        mode: 'h2h',
        inviteCode: match.body.inviteCode,
      });

      const guestSocket = await connect(
        replicaB.baseUrl,
        guest.accessToken,
        match.body.id,
      );

      const placed = nextEvent(guestSocket, MATCH_EVENTS.OPPONENT_PLACED);
      const hostPlay = await playRound(host.api, hostSession.body.id, 0);
      const payload: any = await placed;

      expect(payload.matchId).toBe(match.body.id);
      expect(payload.userId).toBe(host.userId);
      expect(payload.roundIndex).toBe(0);
      expect(payload.points).toBe(hostPlay.reveal.round.points);
      // Carries the result, never the price — the guest has not bet yet.
      expect(JSON.stringify(payload)).not.toContain(
        String(hostPlay.reveal.round.truePriceCents),
      );

      // Once the guest answers the same round, the match awards it.
      const advanced = nextEvent<any>(guestSocket, MATCH_EVENTS.ROUND_ADVANCED);
      const guestPlay = await playRound(guest.api, guestSession.body.id, 0);
      const advance = await advanced;

      expect(advance.roundIndex).toBe(0);
      expect(advance.hostScore + advance.guestScore).toBe(
        hostPlay.reveal.round.points === guestPlay.reveal.round.points ? 0 : 1,
      );
    });

    it('announces a join to a socket held on the other replica', async () => {
      const host = await registerPlayer(
        replicaA.api,
        'h2h-host-0007',
        'waitera',
      );
      const guest = await registerPlayer(
        replicaB.api,
        'h2h-guest-0007',
        'joinerb',
      );

      const match = await host.api.post('/v1/matches', {
        themeSlug: 'vintage-finds',
      });

      const hostSocket = await connect(
        replicaA.baseUrl,
        host.accessToken,
        match.body.id,
      );

      const announced = nextEvent<any>(
        hostSocket,
        MATCH_EVENTS.OPPONENT_JOINED,
      );
      await guest.api.post('/v1/matches/join', {
        inviteCode: match.body.inviteCode,
      });

      expect((await announced).matchId).toBe(match.body.id);
    });

    /**
     * Presence *is* the socket — there is no separate store to drift — which
     * only works because `fetchSockets()` under the Redis adapter reaches
     * every replica.
     */
    it('reports a player connected to one replica as online from the other', async () => {
      const host = await registerPlayer(
        replicaA.api,
        'h2h-host-0008',
        'presenta',
      );
      const guest = await registerPlayer(
        replicaB.api,
        'h2h-guest-0008',
        'presentb',
      );

      const match = await host.api.post('/v1/matches', {
        themeSlug: 'vintage-finds',
      });
      await guest.api.post('/v1/matches/join', {
        inviteCode: match.body.inviteCode,
      });

      const before = await guest.api.get(`/v1/matches/${match.body.id}`);
      expect(before.body.host.online).toBe(false);

      await connect(replicaA.baseUrl, host.accessToken, match.body.id);

      const after = await guest.api.get(`/v1/matches/${match.body.id}`);
      expect(after.body.host.online).toBe(true);
      expect(after.body.guest.online).toBe(false);
    });

    it('disconnects a socket that presents no token', async () => {
      const socket = io(`${replicaA.baseUrl}/matches`, {
        transports: ['websocket'],
        forceNew: true,
      });
      sockets.push(socket);

      const outcome = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('still connected'), 5_000);
        const settle = (result: string) => {
          clearTimeout(timer);
          resolve(result);
        };
        socket.once('disconnect', () => settle('disconnected'));
        socket.once('connect_error', () => settle('refused'));
      });

      expect(['disconnected', 'refused']).toContain(outcome);
    });

    it('does not let an authenticated non-player join a match room', async () => {
      const host = await registerPlayer(
        replicaA.api,
        'h2h-host-room-auth',
        'roomhost',
      );
      const guest = await registerPlayer(
        replicaB.api,
        'h2h-guest-room-auth',
        'roomguest',
      );
      const gatecrasher = await registerPlayer(
        replicaA.api,
        'h2h-gatecrasher-room-auth',
        'outsider',
      );
      const match = await host.api.post('/v1/matches', {
        themeSlug: 'vintage-finds',
      });
      await guest.api.post('/v1/matches/join', {
        inviteCode: match.body.inviteCode,
      });

      const socket = await openSocket(
        replicaA.baseUrl,
        gatecrasher.accessToken,
      );
      const rejected = nextEvent<any>(socket, 'exception');
      socket.emit('joinMatch', { matchId: match.body.id });

      expect((await rejected).message).toBe('Not allowed to join this match');

      const gateway = replicaA.app.get(MatchesGateway);
      const occupants = await gateway.server
        .in(`match:${match.body.id}`)
        .fetchSockets();
      expect(
        occupants.some(
          (occupant) => Number(occupant.data.userId) === gatecrasher.userId,
        ),
      ).toBe(false);
    });
  });

  describe('finishing a match', () => {
    it('scores it by rounds won and names a winner', async () => {
      const host = await registerPlayer(
        replicaA.api,
        'h2h-host-0009',
        'finisha',
      );
      const guest = await registerPlayer(
        replicaB.api,
        'h2h-guest-0009',
        'finishb',
      );

      const match = await host.api.post('/v1/matches', {
        themeSlug: 'vintage-finds',
      });
      await guest.api.post('/v1/matches/join', {
        inviteCode: match.body.inviteCode,
      });

      const hostSession = await host.api.post('/v1/sessions', {
        mode: 'h2h',
        inviteCode: match.body.inviteCode,
      });
      const guestSession = await guest.api.post('/v1/sessions', {
        mode: 'h2h',
        inviteCode: match.body.inviteCode,
      });

      const rounds = hostSession.body.roundCount as number;
      const hostPoints: number[] = [];
      const guestPoints: number[] = [];

      for (let index = 0; index < rounds; index++) {
        // The host bets the server's suggested range; the guest bets the
        // widest legal one, so the two rarely score alike.
        const hostPlay = await playRound(host.api, hostSession.body.id, index);
        hostPoints.push(hostPlay.reveal.round.points);

        const guestCurrent = await guest.api.get(
          `/v1/sessions/${guestSession.body.id}/current`,
        );
        const guestPlay = await playRound(
          guest.api,
          guestSession.body.id,
          index,
          {
            loCents: guestCurrent.body.sliderMinCents,
            hiCents: guestCurrent.body.sliderMaxCents,
          },
        );
        guestPoints.push(guestPlay.reveal.round.points);
      }

      const expectedHostWins = hostPoints.filter(
        (points, index) => points > guestPoints[index],
      ).length;
      const expectedGuestWins = guestPoints.filter(
        (points, index) => points > hostPoints[index],
      ).length;

      // Match state commits in the final bet transaction; no event or polling
      // window is required before an HTTP read can recover the result.
      const final = await host.api.get(`/v1/matches/${match.body.id}`);

      expect(final.status).toBe(200);
      expect(final.body.status).toBe('complete');
      expect(final.body.host.score).toBe(expectedHostWins);
      expect(final.body.guest.score).toBe(expectedGuestWins);
      expect(final.body.host.roundsPlayed).toBe(rounds);

      const expectedWinner =
        expectedHostWins === expectedGuestWins
          ? null
          : expectedHostWins > expectedGuestWins
            ? host.userId
            : guest.userId;
      expect(final.body.winnerUserId).toBe(expectedWinner);
    });

    it('carries the opponent block on a head-to-head reveal', async () => {
      const host = await registerPlayer(
        replicaA.api,
        'h2h-host-0010',
        'blocka',
      );
      const guest = await registerPlayer(
        replicaB.api,
        'h2h-guest-0010',
        'blockb',
      );

      const match = await host.api.post('/v1/matches', {
        themeSlug: 'vintage-finds',
      });
      await guest.api.post('/v1/matches/join', {
        inviteCode: match.body.inviteCode,
      });

      const hostSession = await host.api.post('/v1/sessions', {
        mode: 'h2h',
        inviteCode: match.body.inviteCode,
      });
      const guestSession = await guest.api.post('/v1/sessions', {
        mode: 'h2h',
        inviteCode: match.body.inviteCode,
      });

      await playRound(host.api, hostSession.body.id, 0);
      const guestPlay = await playRound(guest.api, guestSession.body.id, 0);

      expect(guestPlay.reveal.match).not.toBeNull();
      expect(guestPlay.reveal.match.matchId).toBe(match.body.id);
      expect(guestPlay.reveal.match.opponentUsername).toBe('blocka');
      // The opponent has played this round, so their result is known.
      expect(guestPlay.reveal.match.opponentRoundPoints).toEqual(
        expect.any(Number),
      );
    });
  });
});

async function sessionItemIds(
  ctx: TestApp,
  sessionId: string,
): Promise<number[]> {
  const [row] = await ctx.dataSource.query(
    'SELECT "itemIds" FROM game_session WHERE id = $1',
    [sessionId],
  );

  return row.itemIds.map(Number);
}
