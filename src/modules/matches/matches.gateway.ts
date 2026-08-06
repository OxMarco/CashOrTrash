import { Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
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
import { Server, Socket } from 'socket.io';

import { AuthConfig } from 'src/config/configuration';
import { AccessTokenPayload, TokenType } from '../auth/auth.types';
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

interface SocketData {
  userId: number;
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

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly matches: MatchesReadService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = extractToken(client);
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.getOrThrow<AuthConfig>('auth').accessSecret,
      });
      if (payload.typ !== TokenType.ACCESS) {
        throw new UnauthorizedException('Access token required');
      }
      const userId = Number(payload.sub);
      if (!Number.isSafeInteger(userId) || userId <= 0) {
        throw new UnauthorizedException('Invalid player');
      }
      (client.data as SocketData).userId = userId;
    } catch {
      // No error frame with details: an unauthenticated socket learns nothing.
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Socket ${client.id} disconnected`);
  }

  /** A room is the authorization boundary for match events, so joining checks it. */
  @SubscribeMessage('joinMatch')
  async joinMatch(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ joined: string }> {
    const matchId = matchIdFrom(body);
    const userId = authenticatedUserId(client);

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

  /** Cross-replica: the Redis adapter makes `fetchSockets` cluster-wide. */
  async isOnline(matchId: string, userId: number): Promise<boolean> {
    if (!this.server) return false;
    try {
      const sockets = await this.server.in(room(matchId)).fetchSockets();
      return sockets.some(
        (socket) => (socket.data as SocketData).userId === userId,
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'Presence lookup failed');
      return false;
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
