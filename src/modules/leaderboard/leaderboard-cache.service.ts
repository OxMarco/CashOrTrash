import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';

import { withLongStatements } from 'src/common/database/long-statements';
import { isoWeekDates, todayUtc } from 'src/common/utils/date.util';
import { AppRedis } from 'src/redis/redis-commands';
import { REDIS_CLIENT } from 'src/redis/redis.constants';
import { Friendship } from '../friends/entities/friendship.entity';
import { DailyScore } from './entities/daily-score.entity';
import {
  DAILY_TTL_SECONDS,
  boardReadyKey,
  boardRebuildLockKey,
  dailyKey,
  FRIENDS_TTL_SECONDS,
  friendsKey,
  LeaderboardScope,
  WEEK_TTL_SECONDS,
  weekKey,
} from './leaderboard.keys';
import { execRedisTransaction, toMember } from './leaderboard.redis';

const REBUILD_LOCK_MS = 10_000;
const REBUILD_WAIT_MS = 100;
const REBUILD_WAIT_ATTEMPTS = 150;

/** Resolves and reconstructs the Redis serving layer from authoritative rows. */
@Injectable()
export class LeaderboardCacheService {
  private readonly logger = new Logger(LeaderboardCacheService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: AppRedis,
    @InjectRepository(DailyScore)
    private readonly dailyScores: Repository<DailyScore>,
    @InjectRepository(Friendship)
    private readonly friendships: Repository<Friendship>,
  ) {}

  async resolveKey(
    scope: LeaderboardScope,
    userId: number,
    now: Date,
  ): Promise<string> {
    if (scope === 'friends') return this.buildFriendsKey(userId, now);

    const key = scope === 'week' ? weekKey(now) : dailyKey(todayUtc(now));
    await this.ensureBoardReady(scope === 'week' ? 'week' : 'today', now, key);
    return key;
  }

  private async ensureBoardReady(
    scope: 'today' | 'week',
    now: Date,
    key: string,
  ): Promise<void> {
    const readyKey = boardReadyKey(key);
    const deadline = Date.now() + REBUILD_WAIT_ATTEMPTS * REBUILD_WAIT_MS;

    for (;;) {
      if ((await this.redis.exists(readyKey)) > 0) return;
      if (await this.rebuildUnderLease(scope, now, key, readyKey)) return;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, REBUILD_WAIT_MS));
    }

    this.logger.warn(
      `Timed out waiting for a leaderboard rebuild of ${key}; ` +
        'serving the board as it stands',
    );
  }

  private async rebuildUnderLease(
    scope: 'today' | 'week',
    now: Date,
    key: string,
    readyKey: string,
  ): Promise<boolean> {
    const lockKey = boardRebuildLockKey(key);
    const token = randomUUID();
    const acquired = await this.redis.set(
      lockKey,
      token,
      'PX',
      REBUILD_LOCK_MS,
      'NX',
    );
    if (acquired !== 'OK') return false;

    try {
      if ((await this.redis.exists(readyKey)) === 0) {
        await this.rebuild(scope, now);
      }
      return true;
    } finally {
      await this.redis.deleteIfValue(lockKey, token);
    }
  }

  private async buildFriendsKey(userId: number, now: Date): Promise<string> {
    const key = friendsKey(userId);
    const sourceKey = await this.resolveKey('today', userId, now);
    const friends = await this.friendships.find({ where: { userId } });
    const memberIds = [userId, ...friends.map((friend) => friend.friendUserId)];
    const scores = await this.redis.zmscore(
      sourceKey,
      ...memberIds.map(toMember),
    );

    const pipeline = this.redis.multi().del(key);
    memberIds.forEach((id, index) => {
      const score = scores?.[index];
      if (score !== null && score !== undefined) {
        pipeline.zadd(key, Number(score), toMember(id));
      }
    });
    pipeline.expire(key, FRIENDS_TTL_SECONDS);
    await execRedisTransaction(pipeline, 'friends leaderboard build');
    return key;
  }

  async rebuild(
    scope: 'today' | 'week',
    now: Date = new Date(),
  ): Promise<number> {
    const dates = scope === 'week' ? isoWeekDates(now) : [todayUtc(now)];
    const key = scope === 'week' ? weekKey(now) : dailyKey(todayUtc(now));
    const ttl = scope === 'week' ? WEEK_TTL_SECONDS : DAILY_TTL_SECONDS;

    // Read the snapshot, then publish it outside any transaction. An earlier
    // revision held LOCK TABLE ... IN SHARE MODE across the Redis round trips
    // below, which blocked every daily_score write cluster-wide for the
    // duration of a full-board rebuild. The lock also did not buy what it
    // looked like it bought: SHARE is self-compatible, so a rebuild and a
    // score mirror ran under it concurrently anyway.
    //
    // The join keeps deleted accounts out of the snapshot. A deletion that
    // lands between this read and the RENAME can still be republished; the
    // scrub in `removeUser`, the hourly rebuild and the key TTL all remove it,
    // and no lock available here would close that window without reintroducing
    // the cluster-wide stall.
    //
    // A whole week of scores in one aggregate, so it runs under the
    // maintenance timeout rather than the request one — see
    // `withLongStatements`. The transaction is only there to scope that
    // setting; it takes no locks.
    const rows = await withLongStatements(this.dailyScores.manager, (manager) =>
      manager
        .getRepository(DailyScore)
        .createQueryBuilder('s')
        .innerJoin('user', 'u', 'u.id = s."userId"')
        .select('s.userId', 'userId')
        .addSelect('SUM(s.score)', 'score')
        .where('s.challengeDate IN (:...dates)', { dates })
        .groupBy('s.userId')
        .getRawMany<{ userId: number; score: string }>(),
    );

    await this.replaceBoard(key, ttl, rows);
    this.logger.log(`Rebuilt ${key} from ${rows.length} rows`);
    return rows.length;
  }

  private async replaceBoard(
    key: string,
    ttl: number,
    totals: Array<{ userId: number; score: string }>,
  ): Promise<void> {
    if (totals.length === 0) {
      await this.redis.del(key);
      await this.redis.set(boardReadyKey(key), '1', 'EX', ttl);
      return;
    }

    const temporary = `${key}:rebuild:${randomUUID()}`;
    try {
      const pipeline = this.redis.multi().del(temporary);
      for (const row of totals) {
        pipeline.zadd(
          temporary,
          Number.parseInt(row.score, 10),
          toMember(row.userId),
        );
      }
      pipeline.expire(temporary, ttl);
      await execRedisTransaction(pipeline, `leaderboard stage ${key}`);
      await this.redis.rename(temporary, key);
      await this.redis.set(boardReadyKey(key), '1', 'EX', ttl);
    } finally {
      await this.redis.del(temporary).catch(() => undefined);
    }
  }
}
