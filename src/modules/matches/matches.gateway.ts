import { Inject, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { isUUID } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { Server, Socket } from 'socket.io';
import { Repository } from 'typeorm';

import { AuthConfig } from 'src/config/configuration';
import { AppRedis } from 'src/redis/redis-commands';
import { REDIS_CLIENT } from 'src/redis/redis.constants';
import { AccessTokenPayload, TokenType } from '../auth/auth.types';
import { User } from '../users/entities/user.entity';
import { Match } from './entities/match.entity';
import { MatchesReadService } from './matches-read.service';

export const MATCH_EVENTS = {
  OPPONENT_JOINED: 'opponentJoined',
  OPPONENT_PLACED: 'opponentPlaced',
  ROUND_ADVANCED: 'roundAdvanced',
  MATCH_COMPLETE: 'matchComplete',
} as const;

const room = (matchId: string): string => `match:${matchId}`;
const MAX_MATCH_ROOMS_PER_SOCKET = 8;
const MAX_SOCKETS_PER_USER = 5;
const CONNECTION_KEY_TTL_SLACK_SECONDS = 60;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface SocketData {
  userId: number;
  connectionKey: string;
  connectionMember: string;
}

/**
 * Rooms are `match:{id}` and the adapter is Redis-backed, so two clients on
 * different replicas share a room. Presence on this socket *is* the live dot
 * beside "vs Maria" — there is no separate presence store to drift.
 */
@WebSocketGateway({ namespace: '/matches' })
export class MatchesGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(MatchesGateway.name);
  private readonly instanceId = randomUUID();
  private readonly expiryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /**
   * Authentication still in flight, by socket id.
   *
   * Socket.IO hands the client its `connect` the moment the transport is up and
   * then delivers whatever it sends next — it does not wait on
   * `handleConnection`. That was survivable while authenticating was a bare
   * `verifyAsync`, which settles inside a microtask; it stopped being
   * survivable once the connection lease added a database round trip and a
   * Redis script, because a client that emits the instant it is connected now
   * comfortably beats them. It would arrive to find `client.data.userId` unset
   * and be told "Authentication required" — and worse, be told it in an
   * `exception` frame with no ack, so a caller using `emitWithAck` waits for a
   * reply that is never coming.
   *
   * Handlers await this instead of assuming the connection hook has finished.
   * Removed as soon as it settles, so a socket past that point costs nothing.
   */
  private readonly authenticating = new Map<string, Promise<void>>();

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly matches: MatchesReadService,
    @InjectRepository(User) private readonly users: Repository<User>,
    @Inject(REDIS_CLIENT) private readonly redis: AppRedis,
  ) {}

  handleConnection(client: Socket): Promise<void> {
    // Registered synchronously, before any awaiting happens inside
    // `authenticate`, so an event arriving on the very next tick always finds
    // the promise it has to wait for.
    const settled = this.authenticate(client).finally(() => {
      this.authenticating.delete(client.id);
    });
    this.authenticating.set(client.id, settled);
    return settled;
  }

  /**
   * Blocks until this socket's authentication has resolved one way or the
   * other, then reads the identity it established.
   *
   * A socket refused by `authenticate` is disconnected rather than marked, so
   * the read after the wait is what turns a refusal into the handler's error.
   */
  private async identify(client: Socket): Promise<number> {
    // `authenticate` handles its own failures, so this can only be pending or
    // fulfilled; the catch is here so a future throw inside it degrades to
    // "not authenticated" rather than escaping as an unhandled rejection.
    await this.authenticating.get(client.id)?.catch(() => undefined);
    return authenticatedUserId(client);
  }

  private async authenticate(client: Socket): Promise<void> {
    let connection: Pick<
      SocketData,
      'connectionKey' | 'connectionMember'
    > | null = null;
    try {
      const token = extractToken(client);
      const payload = await this.jwt.verifyAsync<
        AccessTokenPayload & { exp?: number }
      >(token, {
        secret: this.config.getOrThrow<AuthConfig>('auth').accessSecret,
      });
      if (payload.typ !== TokenType.ACCESS) {
        throw new UnauthorizedException('Access token required');
      }
      const userId = Number(payload.sub);
      if (!Number.isSafeInteger(userId) || userId <= 0) {
        throw new UnauthorizedException('Invalid player');
      }
      if (!(await this.users.exist({ where: { id: userId } }))) {
        throw new UnauthorizedException('Player no longer exists');
      }

      const expiresAtMs = Number(payload.exp) * 1000;
      const now = Date.now();
      if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now) {
        throw new UnauthorizedException('Expiring access token required');
      }

      const connectionKey = `ws:connections:user:${userId}`;
      const connectionMember = `${this.instanceId}:${client.id}`;
      const keyTtlSeconds =
        Math.ceil((expiresAtMs - now) / 1000) +
        CONNECTION_KEY_TTL_SLACK_SECONDS;
      const acquired = await this.redis.acquireSocketConnection(
        connectionKey,
        now,
        MAX_SOCKETS_PER_USER,
        expiresAtMs,
        connectionMember,
        keyTtlSeconds,
      );
      if (Number(acquired) !== 1) {
        throw new UnauthorizedException('Too many live connections');
      }

      connection = { connectionKey, connectionMember };
      (client.data as SocketData).userId = userId;
      (client.data as SocketData).connectionKey = connectionKey;
      (client.data as SocketData).connectionMember = connectionMember;

      this.scheduleExpiry(client, expiresAtMs);
    } catch (error) {
      if (connection) await this.releaseConnection(connection);
      this.logger.debug(
        { err: error, socketId: client.id },
        'Socket authentication refused',
      );
      // No error frame with details: an unauthenticated socket learns nothing.
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    // The same race, seen from the other end. A socket that drops while it is
    // still authenticating would otherwise be cleaned up *before* the lease it
    // is about to take exists, leaving that lease held until the key's TTL —
    // and five of those in a row lock the account out of its own sockets for
    // the lifetime of its token. Waiting costs nothing: nothing awaits this
    // hook, and the refusal path releases its own lease anyway.
    await this.authenticating.get(client.id)?.catch(() => undefined);

    const timer = this.expiryTimers.get(client.id);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(client.id);

    const data = client.data as Partial<SocketData>;
    if (data.connectionKey && data.connectionMember) {
      await this.releaseConnection({
        connectionKey: data.connectionKey,
        connectionMember: data.connectionMember,
      });
    }
    this.logger.debug(`Socket ${client.id} disconnected`);
  }

  private async releaseConnection(
    connection: Pick<SocketData, 'connectionKey' | 'connectionMember'>,
  ): Promise<void> {
    try {
      await this.redis.zrem(
        connection.connectionKey,
        connection.connectionMember,
      );
    } catch (error) {
      this.logger.warn(
        { err: error },
        'Socket connection lease cleanup failed',
      );
    }
  }

  private scheduleExpiry(client: Socket, expiresAtMs: number): void {
    const remaining = expiresAtMs - Date.now();
    if (remaining <= 0) {
      client.disconnect(true);
      return;
    }

    const timer = setTimeout(
      () => this.scheduleExpiry(client, expiresAtMs),
      Math.min(remaining, MAX_TIMER_DELAY_MS),
    );
    timer.unref();
    this.expiryTimers.set(client.id, timer);
  }

  /** A room is the authorization boundary for match events, so joining checks it. */
  @SubscribeMessage('joinMatch')
  async joinMatch(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ joined: string }> {
    const matchId = matchIdFrom(body);
    const userId = await this.identify(client);

    try {
      await this.matches.getForPlayer(matchId, userId);
    } catch {
      // Do not reveal whether an arbitrary UUID names a real match.
      throw new WsException('Not allowed to join this match');
    }

    const matchRoom = room(matchId);
    const joinedMatchRooms = [...client.rooms].filter((value) =>
      value.startsWith('match:'),
    );
    if (
      !client.rooms.has(matchRoom) &&
      joinedMatchRooms.length >= MAX_MATCH_ROOMS_PER_SOCKET
    ) {
      throw new WsException('Too many joined matches');
    }

    await client.join(matchRoom);
    client.to(matchRoom).emit(MATCH_EVENTS.OPPONENT_JOINED, {
      matchId,
      userId,
    });

    return { joined: matchId };
  }

  @SubscribeMessage('leaveMatch')
  async leaveMatch(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ left: string }> {
    const matchId = matchIdFrom(body);
    await client.leave(room(matchId));
    return { left: matchId };
  }

  /**
   * Who is currently in this match's room, across every replica.
   *
   * The whole room in one call, rather than a `isOnline(matchId, userId)` per
   * player. `fetchSockets` under the Redis adapter is a broadcast-and-collect
   * over the cluster, and a match DTO renders two players — so asking per
   * player made the commonest read of a match two cluster round trips to
   * answer a question one covers. An empty set on failure: the live dot going
   * dark is a better answer than the match failing to load.
   */
  async onlineUserIds(matchId: string): Promise<Set<number>> {
    if (!this.server) return new Set();
    try {
      const sockets = await this.server.in(room(matchId)).fetchSockets();
      const userIds = new Set<number>();
      for (const socket of sockets) {
        const userId = (socket.data as Partial<SocketData>).userId;
        if (typeof userId === 'number') userIds.add(userId);
      }
      return userIds;
    } catch (error) {
      this.logger.warn({ err: error }, 'Presence lookup failed');
      return new Set();
    }
  }

  emitOpponentJoined(match: Match, joinedUserId: number): void {
    this.emit(match.id, MATCH_EVENTS.OPPONENT_JOINED, {
      matchId: match.id,
      userId: joinedUserId,
    });
  }

  /**
   * Deliberately carries points and hit, never the true price — the opponent
   * may not have played this round yet.
   */
  emitOpponentPlaced(
    matchId: string,
    payload: {
      userId: number;
      roundIndex: number;
      points: number;
      hit: boolean;
    },
  ): void {
    this.emit(matchId, MATCH_EVENTS.OPPONENT_PLACED, { matchId, ...payload });
  }

  emitRoundAdvanced(
    matchId: string,
    payload: { roundIndex: number; hostScore: number; guestScore: number },
  ): void {
    this.emit(matchId, MATCH_EVENTS.ROUND_ADVANCED, { matchId, ...payload });
  }

  emitMatchComplete(
    matchId: string,
    payload: {
      hostScore: number;
      guestScore: number;
      winnerUserId: number | null;
    },
  ): void {
    this.emit(matchId, MATCH_EVENTS.MATCH_COMPLETE, { matchId, ...payload });
  }

  private emit(matchId: string, event: string, payload: unknown): void {
    // The gateway may not be initialised in unit tests or during shutdown.
    this.server?.to(room(matchId)).emit(event, payload);
  }
}

const extractToken = (client: Socket): string => {
  const fromAuth = (client.handshake.auth as { token?: string })?.token;
  if (fromAuth) return fromAuth.replace(/^Bearer\s+/i, '');

  const header = client.handshake.headers.authorization;
  if (header) return header.replace(/^Bearer\s+/i, '');

  throw new UnauthorizedException('Missing token');
};

const matchIdFrom = (body: unknown): string => {
  const matchId =
    body && typeof body === 'object'
      ? (body as { matchId?: unknown }).matchId
      : undefined;
  if (typeof matchId !== 'string' || !isUUID(matchId, '4')) {
    throw new WsException('A valid matchId is required');
  }
  return matchId;
};

const authenticatedUserId = (client: Socket): number => {
  const userId = (client.data as Partial<SocketData>).userId;
  if (!Number.isSafeInteger(userId) || (userId ?? 0) <= 0) {
    throw new WsException('Authentication required');
  }
  return userId!;
};
