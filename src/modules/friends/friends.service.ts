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
