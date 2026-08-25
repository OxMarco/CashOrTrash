import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { toDto } from 'src/common/serialization/to-dto';
import { todayUtc } from 'src/common/utils/date.util';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { FriendDto, FriendListDto } from './dto/friend.dto';
import { Friendship } from './entities/friendship.entity';

/**
 * The most friends one account may hold.
 *
 * Not a product opinion so much as the bound that makes the two readers safe.
 * Nothing paginates a friend list: `list` fetches every edge and then every
 * profile behind it, and `buildFriendsKey` turns the same list into a ZMSCORE
 * with one argument per friend followed by a pipeline of one ZADD per friend —
 * rebuilt on *every* friends-leaderboard request, because the board is derived
 * rather than maintained. Uncapped, one account adding all night makes both of
 * those unbounded, and the Redis one is unbounded per request.
 *
 * Five hundred is far past what the feature is for — a friends board is people
 * you know — and far short of where either fan-out is a problem.
 */
export const MAX_FRIENDS = 500;

@Injectable()
export class FriendsService {
  constructor(
    @InjectRepository(Friendship)
    private readonly friendships: Repository<Friendship>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly usersService: UsersService,
  ) {}

  async list(userId: number): Promise<FriendListDto> {
    const edges = await this.friendships.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    const friends = await this.hydrate(edges);
    return toDto(FriendListDto, { friends, count: friends.length });
  }

  /**
   * Friendship is mutual and immediate: two rows go in, and both boards update
   * at once. There is no request/accept step because there is nothing to
   * consent to — the friends board exposes a username, an avatar and a daily
   * score, all of which the global board already shows. Adding an approval
   * flow later means adding a `status` column, not reshaping this.
   */
  async add(userId: number, username: string): Promise<FriendDto> {
    // `username` is citext, so this matches regardless of the case the player
    // typed, exactly like the availability check does.
    const target = await this.users.findOne({ where: { username } });
    if (!target) throw new NotFoundException('No player with that name');

    if (target.id === userId) {
      throw new BadRequestException('You cannot add yourself');
    }

    // Answered before the cap is consulted, which is what keeps a retried tap
    // idempotent at the cap: an existing friendship is already counted, so
    // checking the ceiling first would start refusing the retry that the
    // `orIgnore` below exists to absorb. It also makes the common repeat case
    // the cheaper path rather than the more expensive one.
    const existing = await this.friendships.findOne({
      where: { userId, friendUserId: target.id },
    });
    if (existing) return this.toFriendDto(target, existing.createdAt);

    await this.enforceFriendLimit(userId, target.id);

    // One statement, so the pair can never end up half-written; `orIgnore`
    // makes re-adding an existing friend a no-op rather than a 409, which is
    // what the client wants when a tap is retried on a flaky connection.
    await this.friendships
      .createQueryBuilder()
      .insert()
      .into(Friendship)
      .values([
        { userId, friendUserId: target.id },
        { userId: target.id, friendUserId: userId },
      ])
      .orIgnore()
      .execute();

    const edge = await this.friendships.findOneOrFail({
      where: { userId, friendUserId: target.id },
    });

    return this.toFriendDto(target, edge.createdAt);
  }

  /**
   * Both sides, because the write is both sides.
   *
   * Adding a friend puts an edge on the other player's list too, and they never
   * agreed to it — there is no request/accept step. So capping only the caller
   * would bound nothing: a thousand accounts each adding the same victim once
   * would hand that victim a thousand-edge list they cannot refuse, and it is
   * their list that then gets rebuilt into Redis on every board they open.
   *
   * A soft cap, deliberately. Two concurrent adds can both read a count one
   * below the ceiling and both commit, so the true bound is "about
   * `MAX_FRIENDS`" rather than exactly it. Serialising this would mean locking
   * two user rows on a social action to defend a limit that exists to keep a
   * fan-out proportionate, and being a handful over does not threaten that.
   */
  private async enforceFriendLimit(
    userId: number,
    targetUserId: number,
  ): Promise<void> {
    const [mine, theirs] = await Promise.all([
      this.friendships.count({ where: { userId } }),
      this.friendships.count({ where: { userId: targetUserId } }),
    ]);

    if (mine >= MAX_FRIENDS) {
      throw new BadRequestException(
        `You can have at most ${MAX_FRIENDS} friends — remove one to add another`,
      );
    }
    if (theirs >= MAX_FRIENDS) {
      // Says whose limit it is without saying anything the 404 above has not
      // already confirmed about that account existing.
      throw new BadRequestException(
        'That player already has as many friends as they can hold',
      );
    }
  }

  async remove(userId: number, friendUserId: number): Promise<void> {
    // Both directions in one statement: leaving one row behind would keep the
    // ex-friend on one of the two boards.
    await this.friendships
      .createQueryBuilder()
      .delete()
      .from(Friendship)
      .where(
        '("userId" = :a AND "friendUserId" = :b) OR ("userId" = :b AND "friendUserId" = :a)',
        { a: userId, b: friendUserId },
      )
      .execute();
  }

  private async hydrate(edges: Friendship[]): Promise<FriendDto[]> {
    if (edges.length === 0) return [];

    const profiles = await this.users.find({
      where: { id: In(edges.map((edge) => edge.friendUserId)) },
    });
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));

    return edges
      .map((edge) => {
        const profile = byId.get(edge.friendUserId);
        return profile ? this.toFriendDto(profile, edge.createdAt) : null;
      })
      .filter((friend): friend is FriendDto => friend !== null);
  }

  private toFriendDto(user: User, friendsSince: Date): FriendDto {
    return toDto(FriendDto, {
      userId: user.id,
      username: user.username,
      avatarSeed: user.avatarSeed,
      totalPoints: user.totalPoints,
      streakDays: this.usersService.effectiveStreak(user, todayUtc()),
      friendsSince,
    });
  }
}
