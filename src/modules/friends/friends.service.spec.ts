import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { Friendship } from './entities/friendship.entity';
import { FriendsService, MAX_FRIENDS } from './friends.service';

describe('the ceiling on one player’s friend list', () => {
  const target = { id: 2, username: 'maria', avatarSeed: 'aa', totalPoints: 0 };

  const makeService = (over: {
    existingEdge?: { createdAt: Date } | null;
    mine?: number;
    theirs?: number;
  }) => {
    const counts = jest
      .fn()
      .mockImplementation(({ where }: { where: { userId: number } }) =>
        Promise.resolve(
          where.userId === 1 ? (over.mine ?? 0) : (over.theirs ?? 0),
        ),
      );

    const friendships = {
      findOne: jest.fn().mockResolvedValue(over.existingEdge ?? null),
      findOneOrFail: jest.fn().mockResolvedValue({ createdAt: new Date(0) }),
      count: counts,
      createQueryBuilder: jest.fn().mockReturnValue({
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        orIgnore: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
      }),
    } as unknown as Repository<Friendship>;

    const users = {
      findOne: jest.fn().mockResolvedValue(target),
    } as unknown as Repository<User>;

    const usersService = {
      effectiveStreak: () => 0,
    } as unknown as UsersService;

    return {
      service: new FriendsService(friendships, users, usersService),
      friendships,
    };
  };

  it('refuses a new friend once the caller is full', async () => {
    const { service } = makeService({ mine: MAX_FRIENDS });

    await expect(service.add(1, 'maria')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  /**
   * The half that capping the caller alone would miss. Nobody consents to being
   * added — the write puts an edge on both lists — so without this a thousand
   * accounts adding one victim once each would hand that victim a list they
   * never asked for and cannot refuse.
   */
  it('refuses when it is the *other* player who is full', async () => {
    const { service } = makeService({ mine: 0, theirs: MAX_FRIENDS });

    await expect(service.add(1, 'maria')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  /**
   * A retried tap on a flaky connection must still succeed at the cap: the
   * existing edge is already counted, so consulting the ceiling first would
   * start refusing exactly the request `orIgnore` exists to absorb.
   */
  it('still returns an existing friendship when both lists are full', async () => {
    const { service, friendships } = makeService({
      existingEdge: { createdAt: new Date(0) },
      mine: MAX_FRIENDS,
      theirs: MAX_FRIENDS,
    });

    await expect(service.add(1, 'maria')).resolves.toMatchObject({ userId: 2 });
    // Nothing was written, and the ceiling was never consulted.
    expect(friendships.createQueryBuilder).not.toHaveBeenCalled();
    expect(friendships.count).not.toHaveBeenCalled();
  });

  it('adds normally with room on both sides', async () => {
    const { service, friendships } = makeService({ mine: 3, theirs: 7 });

    await expect(service.add(1, 'maria')).resolves.toMatchObject({ userId: 2 });
    expect(friendships.createQueryBuilder).toHaveBeenCalled();
  });
});
