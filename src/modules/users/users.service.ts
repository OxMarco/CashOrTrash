import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';

import {
  isPgError,
  PG_UNIQUE_VIOLATION,
} from 'src/common/database/pg-error-codes';
import { addDays, todayUtc } from 'src/common/utils/date.util';
import { User } from './entities/user.entity';
import { UsernameService, USERNAME_TAKEN } from './username.service';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly usernames: UsernameService,
    private readonly dataSource: DataSource,
  ) {}

  findById(id: number): Promise<User | null> {
    return this.users.findOne({ where: { id } });
  }

  async getById(id: number): Promise<User> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('Player not found');
    return user;
  }

  /**
   * Two devices posting the same id concurrently must not create two players.
   * `ON CONFLICT DO NOTHING` plus a re-read makes the race resolve in the
   * database rather than in a lock we would have to maintain.
   */
  async findOrCreateByDeviceId(
    deviceId: string,
  ): Promise<{ user: User; created: boolean }> {
    const existing = await this.users.findOne({ where: { deviceId } });
    if (existing) return { user: existing, created: false };

    const result = await this.users
      .createQueryBuilder()
      .insert()
      .into(User)
      .values({ deviceId, avatarSeed: randomBytes(8).toString('hex') })
      .orIgnore()
      .returning('*')
      .execute();

    const inserted = result.raw?.[0] as User | undefined;
    if (inserted) return { user: inserted, created: true };

    // Lost the race — the winner's row is there now.
    const user = await this.users.findOne({ where: { deviceId } });
    if (!user) throw new ConflictException('Could not register device');
    return { user, created: false };
  }

  async isUsernameAvailable(candidate: string): Promise<boolean> {
    const count = await this.users.count({ where: { username: candidate } });
    return count === 0;
  }

  /**
   * The unique index is the arbiter. Checking first and inserting second would
   * leave a window; we let the write fail and translate the violation.
   */
  async claimUsername(userId: number, raw: string): Promise<User> {
    const check = this.usernames.check(raw);
    if (!check.ok) {
      // 400, not 409: the name is not allowed at all. A 409 would tell the
      // client someone else holds it and invite them to retry in a minute.
      // `error` becomes the problem document's `type` — the client switches on
      // that, never on the prose.
      throw new BadRequestException({
        error: this.usernames.problemCode(check.reason!),
        message: this.usernames.describe(check.reason!),
      });
    }

    const user = await this.getById(userId);
    if (user.username === check.normalised) return user;

    try {
      await this.users.update({ id: userId }, { username: check.normalised });
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION)) {
        throw new ConflictException({
          error: USERNAME_TAKEN,
          message: 'That name is already taken',
        });
      }
      throw error;
    }

    return this.getById(userId);
  }

  /**
   * Called once per completed daily session. Consecutive UTC days extend the
   * streak; a gap restarts it at 1; replaying the same day is a no-op, which
   * matters because the caller runs inside the bet transaction and may be
   * replayed by an idempotent retry.
   *
   * `manager` is not optional decoration. The bet transaction has already
   * written the player's row, so it holds a lock on it; opening a *second*
   * transaction here — on a second pooled connection — would block on that
   * lock while the first transaction blocked waiting for this call to return.
   * That is a self-deadlock on the last round of every daily, and it resolves
   * only when the pool times out. Callers already inside a transaction must
   * pass their manager so this joins it instead of racing it.
   */
  async registerDailyPlay(
    userId: number,
    playedOn: string = todayUtc(),
    manager?: EntityManager,
  ): Promise<User> {
    const run = async (entityManager: EntityManager): Promise<User> => {
      const repo = entityManager.getRepository(User);
      const user = await repo.findOne({
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user) throw new NotFoundException('Player not found');

      if (user.streakLastPlayedOn === playedOn) return user;

      const continues =
        user.streakLastPlayedOn !== null &&
        addDays(user.streakLastPlayedOn, 1) === playedOn;

      user.streakDays = continues ? user.streakDays + 1 : 1;
      user.streakLastPlayedOn = playedOn;

      return repo.save(user);
    };

    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  /**
   * A streak is only alive if the last play was today or yesterday — otherwise
   * Home would proudly display a streak the player has already lost. Read-side
   * only; the stored value is corrected on the next play.
   */
  effectiveStreak(user: User, today: string = todayUtc()): number {
    if (!user.streakLastPlayedOn) return 0;
    if (user.streakLastPlayedOn === today) return user.streakDays;
    if (addDays(user.streakLastPlayedOn, 1) === today) return user.streakDays;
    return 0;
  }
}
