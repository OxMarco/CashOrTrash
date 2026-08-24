import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import Redis, { ChainableCommander } from 'ioredis';
import { EntityManager, In, LessThan, MoreThan, Repository } from 'typeorm';

import { toDto } from 'src/common/serialization/to-dto';
import { addDays, isoWeekDates, todayUtc } from 'src/common/utils/date.util';
import { REDIS_CLIENT } from 'src/redis/redis.constants';
import { User } from '../users/entities/user.entity';
import {
  LeaderboardMeDto,
  LeaderboardResponseDto,
  LeaderboardRowDto,
  LeaderboardScopeParam,
} from './dto/leaderboard.dto';
import { DailyScore } from './entities/daily-score.entity';
import { Friendship } from '../friends/entities/friendship.entity';
import {
  DAILY_TTL_SECONDS,
  dailyKey,
  FRIENDS_TTL_SECONDS,
  friendsKey,
  LeaderboardScope,
  WEEK_TTL_SECONDS,
  weekKey,
} from './leaderboard.keys';

/** How many ranked rows the board returns below the podium. */
const ROWS_LIMIT = 50;

/**
 * Members are zero-padded user ids, which is what makes Redis's tie-breaking
 * *deterministic*: it orders equal scores lexicographically, and `"10"` sorts
 * before `"9"` unless both are padded to a fixed width.
 *
 * Determinism is only half the job. Every read here goes through the `ZREV*`
 * family, which reverses the whole ordering — so a tie comes back in
 * *descending* member order, i.e. highest user id first. Postgres must be told
 * to agree: see `ranksFromPostgres` below.
 * Get this wrong and the two stores do not disagree randomly, they disagree
 * consistently and only on ties, which is the kind of bug that reaches
 * production looking like "the leaderboard is occasionally off by one".
 */
const MEMBER_WIDTH = 10;

// The ORDER BY that reproduces `ZREVRANGE` over `MEMBER_WIDTH`-padded ids is
// `score DESC, "userId" DESC` — see `ranksFromPostgres`.
const toMember = (userId: number): string =>
  String(userId).padStart(MEMBER_WIDTH, '0');
const fromMember = (member: string): number => Number.parseInt(member, 10);

interface RankedEntry {
  userId: number;
  score: number;
  rank: number;
}

/** Where one player stands on one board, with the company they keep. */
export interface Standing {
  /** Competition rank: one more than the number of players strictly ahead. */
  rank: number;
  /** How many *other* players share this exact score. */
  sharedWith: number;
  /** Percent of the other players beaten, 0–100. 100 on a board of one. */
  percentile: number;
}

const toStanding = (
  above: number,
  equal: number,
  beaten: number,
  total: number,
): Standing => ({
  rank: above + 1,
  sharedWith: Math.max(0, equal - 1),
  percentile: total <= 1 ? 100 : Math.round((beaten / (total - 1)) * 100),
});

@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger(LeaderboardService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectRepository(DailyScore)
    private readonly dailyScores: Repository<DailyScore>,
    @InjectRepository(Friendship)
    private readonly friendships: Repository<Friendship>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  // --- writes -------------------------------------------------------------

  /**
   * Postgres first, then the serving layer. If the Redis write fails the score
   * is still recorded and `leaderboard-rebuild` will pick it up — the reverse
   * ordering would lose scores permanently on a Redis blip.
   */
  async recordDailyScore(
    userId: number,
    date: string,
    score: number,
  ): Promise<void> {
    await this.persistDailyScore(userId, date, score);

    try {
      await this.syncToRedis(userId, date, score);
    } catch (error) {
      this.logger.warn(
        { err: error, userId, date },
        'Leaderboard cache write failed; rebuild will reconcile',
      );
    }
  }

  /**
   * Removes a deleted account from every live serving key. Postgres is the
   * authority and its rows are removed transactionally by UsersService; this is
   * the privacy cleanup for the short-lived cache so a deleted player does not
   * remain visible until the daily or weekly TTL expires.
   */
  async removeUser(userId: number): Promise<void> {
    const member = toMember(userId);
    let cursor = '0';

    // This key may be the only leaderboard key in an otherwise empty Redis.
    // Delete it outside the scan branch so cleanup does not depend on finding a
    // sorted set first.
    await this.redis.del(friendsKey(userId));

    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        'lb:*',
        'COUNT',
        100,
      );
      cursor = next;

      if (keys.length > 0) {
        const pipeline = this.redis.multi();
        for (const key of keys) pipeline.zrem(key, member);
        await execRedisTransaction(pipeline, 'deleted player cleanup');
      }
    } while (cursor !== '0');
  }

  /**
   * Persist the authoritative row, optionally inside the final-bet transaction.
   * Keeping this separate from Redis closes the crash window between the bet
   * commit and the asynchronous serving-layer update.
   */
  async persistDailyScore(
    userId: number,
    date: string,
    score: number,
    manager?: EntityManager,
  ): Promise<void> {
    const repository = manager?.getRepository(DailyScore) ?? this.dailyScores;
    await repository
      .createQueryBuilder()
      .insert()
      .into(DailyScore)
      .values({ userId, challengeDate: date, score })
      .orUpdate(['score'], ['userId', 'challengeDate'])
      .execute();
  }

  private async syncToRedis(
    userId: number,
    date: string,
    score: number,
  ): Promise<void> {
    const member = toMember(userId);
    const dKey = dailyKey(date);

    // The weekly total is recomputed rather than incremented, so a replayed
    // bet cannot double-count it.
    const weekTotal = await this.weeklyTotalFor(userId, date);

    const transaction = this.redis
      .multi()
      .zadd(dKey, score, member)
      .expire(dKey, DAILY_TTL_SECONDS)
      .zadd(weekKey(new Date(`${date}T00:00:00.000Z`)), weekTotal, member)
      .expire(weekKey(new Date(`${date}T00:00:00.000Z`)), WEEK_TTL_SECONDS);

    await execRedisTransaction(transaction, 'leaderboard score mirror');
  }

  private async weeklyTotalFor(userId: number, date: string): Promise<number> {
    const dates = isoWeekDates(new Date(`${date}T00:00:00.000Z`));
    const { total } = (await this.dailyScores
      .createQueryBuilder('s')
      .select('COALESCE(SUM(s.score), 0)', 'total')
      .where('s.userId = :userId', { userId })
      .andWhere('s.challengeDate IN (:...dates)', { dates })
      .getRawOne<{ total: string }>()) ?? { total: '0' };

    return Number.parseInt(total, 10) || 0;
  }

  // --- reads --------------------------------------------------------------

  /**
   * Competition ranking: one more than the number of players strictly ahead,
   * so equal scores share a rank ("1, 1, 1, 4") rather than being split by
   * user id. ZREVRANK would hand three players on the same score three
   * different places, decided by who signed up last — a fact no player can
   * see, which makes the board look wrong to two of the three.
   */
  async getRank(
    scope: LeaderboardScope,
    userId: number,
    now: Date = new Date(),
  ): Promise<number | null> {
    const key = await this.resolveKey(scope, userId, now);
    const raw = await this.redis.zscore(key, toMember(userId));
    return raw === null ? null : this.rankOfScore(key, raw);
  }

  private async rankOfScore(key: string, score: string): Promise<number> {
    return (await this.redis.zcount(key, `(${score}`, '+inf')) + 1;
  }

  /**
   * "You beat 78% of today's players" — ZCOUNT below the player's score over
   * everyone *else* on the board. O(log n), no table scan.
   *
   * The player is not part of the field they are measured against: with the
   * board to themselves the honest answer is that there was nobody to beat,
   * and in a field of two the winner has beaten everyone, not half of them.
   */
  async getPercentile(
    scope: LeaderboardScope,
    userId: number,
    now: Date = new Date(),
  ): Promise<number | null> {
    const standing = await this.getStanding(scope, userId, now);
    return standing?.percentile ?? null;
  }

  async getStanding(
    scope: LeaderboardScope,
    userId: number,
    now: Date = new Date(),
  ): Promise<Standing | null> {
    const key = await this.resolveKey(scope, userId, now);
    const raw = await this.redis.zscore(key, toMember(userId));
    if (raw === null) return null;

    const [beaten, above, equal, total] = await Promise.all([
      this.redis.zcount(key, '-inf', `(${raw}`),
      this.redis.zcount(key, `(${raw}`, '+inf'),
      this.redis.zcount(key, raw, raw),
      this.redis.zcard(key),
    ]);

    return toStanding(above, equal, beaten, total);
  }

  /**
   * Standing for the date a daily session actually belongs to. Today's board
   * is read from Redis, falling back to the authoritative table for a score
   * the mirror has not caught up with; historical keys are allowed to expire
   * and are read from the table instead of being recreated indefinitely by
   * old summary screens.
   */
  async getDailyStanding(
    userId: number,
    date: string,
    now: Date = new Date(),
  ): Promise<Standing | null> {
    if (date === todayUtc(now)) {
      // The summary is asked for the moment the last bet lands, and the
      // score reaches Redis a beat later — the row is written inside the
      // bet's transaction, the mirror by an async event. Read from Redis
      // when it has the score and from the row when it does not yet, so the
      // one summary a player is certain to look at is never the one with no
      // standing on it.
      const live = await this.getStanding('today', userId, now);
      if (live) return live;
    }

    const row = await this.dailyScores.findOne({
      where: { userId, challengeDate: date },
    });
    if (!row) return null;

    const [beaten, above, equal, total] = await Promise.all([
      this.dailyScores.count({
        where: { challengeDate: date, score: LessThan(row.score) },
      }),
      this.dailyScores.count({
        where: { challengeDate: date, score: MoreThan(row.score) },
      }),
      this.dailyScores.count({
        where: { challengeDate: date, score: row.score },
      }),
      this.dailyScores.count({ where: { challengeDate: date } }),
    ]);

    return toStanding(above, equal, beaten, total);
  }

  async getBoard(
    scope: LeaderboardScopeParam,
    userId: number,
    now: Date = new Date(),
  ): Promise<LeaderboardResponseDto> {
    const key = await this.resolveKey(scope, userId, now);

    const [topRaw, myRankZeroBased, myScoreRaw, totalPlayers] =
      await Promise.all([
        this.redis.zrevrange(key, 0, ROWS_LIMIT - 1, 'WITHSCORES'),
        this.redis.zrevrank(key, toMember(userId)),
        this.redis.zscore(key, toMember(userId)),
        this.redis.zcard(key),
      ]);

    // The top of the board starts at rank 1 by definition; ties inside it
    // share a place (see `getRank`).
    const top = shareRanks(parseWithScores(topRaw, 1));

    // Only fetch the neighbour window if the player sits outside the top rows.
    let neighbours: RankedEntry[] = [];
    if (myRankZeroBased !== null && myRankZeroBased >= ROWS_LIMIT) {
      const from = Math.max(0, myRankZeroBased - 1);
      const raw = await this.redis.zrevrange(key, from, from + 2, 'WITHSCORES');
      const window = parseWithScores(raw, from + 1);
      // The window's first row may be mid-tie with rows above it that were
      // not fetched, so its rank is asked for rather than read off its offset.
      if (window.length > 0) {
        window[0].rank = await this.rankOfScore(key, String(window[0].score));
      }
      neighbours = shareRanks(window);
    }

    const profiles = await this.loadProfiles([
      ...top.map((e) => e.userId),
      ...neighbours.map((e) => e.userId),
    ]);

    const rows = top.map((entry) => this.toRow(entry, profiles, userId));

    const myRank =
      myRankZeroBased === null || myScoreRaw === null
        ? null
        : await this.rankOfScore(key, myScoreRaw);
    const delta =
      scope === LeaderboardScopeParam.TODAY
        ? await this.rankDelta(userId, todayUtc(now), myRank)
        : null;

    // How many share the top place. Read off the ZSET rather than off `top`,
    // which is capped at ROWS_LIMIT and would undercount a wide tie.
    const tiedAtTop =
      top.length > 0
        ? await this.redis.zcount(key, top[0].score, top[0].score)
        : 0;

    const me = toDto(LeaderboardMeDto, {
      rank: myRank,
      score: myScoreRaw === null ? 0 : Number.parseInt(myScoreRaw, 10),
      delta,
      percentile: await this.getPercentile(scope, userId, now),
    });

    return toDto(LeaderboardResponseDto, {
      scope,
      podium: rows.slice(0, 3),
      rows,
      me,
      neighbours: neighbours.map((entry) =>
        this.toRow(entry, profiles, userId),
      ),
      totalPlayers,
      tiedAtTop,
    });
  }

  async rankDelta(
    userId: number,
    date: string,
    currentRank: number | null,
  ): Promise<number | null> {
    if (currentRank === null) return null;

    const previous = await this.dailyScores.findOne({
      where: { userId, challengeDate: addDays(date, -1) },
    });
    if (!previous?.rank) return null;
    // Moving from rank 53 to rank 12 is "▲ 41".
    return previous.rank - currentRank;
  }

  private toRow(
    entry: RankedEntry,
    profiles: Map<number, User>,
    meId: number,
  ): LeaderboardRowDto {
    const profile = profiles.get(entry.userId);
    return toDto(LeaderboardRowDto, {
      rank: entry.rank,
      userId: entry.userId,
      username: profile?.username ?? null,
      avatarSeed: profile?.avatarSeed ?? '',
      score: entry.score,
      isMe: entry.userId === meId,
    });
  }

  private async loadProfiles(ids: number[]): Promise<Map<number, User>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();

    const users = await this.users.find({ where: { id: In(unique) } });
    return new Map(users.map((user) => [user.id, user]));
  }

  // --- key resolution -----------------------------------------------------

  private async resolveKey(
    scope: LeaderboardScope,
    userId: number,
    now: Date,
  ): Promise<string> {
    if (scope === 'friends') return this.buildFriendsKey(userId, now);

    const key = scope === 'week' ? weekKey(now) : dailyKey(todayUtc(now));

    // Redis is a cache: an empty key after a flush is a repair job, not a
    // "nobody has played today".
    if ((await this.redis.exists(key)) === 0) {
      await this.rebuild(scope === 'week' ? 'week' : 'today', now);
    }

    return key;
  }

  /**
   * The friends board is derived, not maintained: intersect the player's
   * friends with today's ZSET into a short-lived key. Nothing to invalidate
   * when a friendship changes.
   */
  private async buildFriendsKey(userId: number, now: Date): Promise<string> {
    const key = friendsKey(userId);
    const sourceKey = await this.resolveKey('today', userId, now);

    const friends = await this.friendships.find({ where: { userId } });
    const memberIds = [userId, ...friends.map((f) => f.friendUserId)];

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

  // --- maintenance jobs ---------------------------------------------------

  /** Reconstruct a ZSET from `daily_score`. The recovery path after a flush. */
  async rebuild(
    scope: 'today' | 'week',
    now: Date = new Date(),
  ): Promise<number> {
    const dates = scope === 'week' ? isoWeekDates(now) : [todayUtc(now)];
    const key = scope === 'week' ? weekKey(now) : dailyKey(todayUtc(now));
    const ttl = scope === 'week' ? WEEK_TTL_SECONDS : DAILY_TTL_SECONDS;

    const totals = await this.dailyScores
      .createQueryBuilder('s')
      .select('s.userId', 'userId')
      .addSelect('SUM(s.score)', 'score')
      .where('s.challengeDate IN (:...dates)', { dates })
      .groupBy('s.userId')
      .getRawMany<{ userId: number; score: string }>();

    // Scores are upsert-only for the lifetime of a daily/weekly key. Merge the
    // authoritative snapshot instead of deleting first: a concurrent final bet
    // may mirror a newer member while this query is in flight, and DEL would
    // erase that committed score until the next repair.
    const pipeline = this.redis.multi();
    for (const row of totals) {
      pipeline.zadd(key, Number.parseInt(row.score, 10), toMember(row.userId));
    }
    pipeline.expire(key, ttl);
    await execRedisTransaction(pipeline, `leaderboard rebuild ${key}`);

    this.logger.log(`Rebuilt ${key} from ${totals.length} rows`);
    return totals.length;
  }

  /**
   * Finalize the standings for one date. Tomorrow's delta compares this rank
   * with the live rank from the adjacent daily row, so both are competition
   * ranks: equal scores share a place, as `getRank` reads them off Redis.
   */
  async snapshotRanks(date: string): Promise<number> {
    const result = await this.dailyScores.query(
      `
      WITH ranked AS (
        SELECT "userId",
               RANK() OVER (ORDER BY score DESC) AS new_rank
        FROM daily_score
        WHERE "challengeDate" = $1
      )
      UPDATE daily_score d
      SET "rank" = r.new_rank
      FROM ranked r
      WHERE d."userId" = r."userId"
        AND d."challengeDate" = $1
        AND d."rank" IS DISTINCT FROM r.new_rank
      `,
      [date],
    );

    const updated = Array.isArray(result) ? ((result[1] as number) ?? 0) : 0;
    this.logger.log(`Snapshotted ranks for ${date} (${updated} rows)`);
    return updated;
  }

  /**
   * Postgres's own view of the ranking, used by the integration test to prove
   * Redis and the source of truth agree. Row order matches `toMember` padding;
   * the rank itself is shared across a tie, as on the ZSET.
   */
  async ranksFromPostgres(date: string): Promise<RankedEntry[]> {
    const rows = await this.dailyScores
      .createQueryBuilder('s')
      .select('s.userId', 'userId')
      .addSelect('s.score', 'score')
      .addSelect('RANK() OVER (ORDER BY s.score DESC)', 'rank')
      .orderBy('s.score', 'DESC')
      .addOrderBy('s.userId', 'DESC')
      .where('s.challengeDate = :date', { date })
      .getRawMany<{ userId: number; score: number; rank: string }>();

    return rows.map((row) => ({
      userId: Number(row.userId),
      score: Number(row.score),
      rank: Number.parseInt(row.rank, 10),
    }));
  }
}

/**
 * Ranks for a descending run of entries whose first rank is known: an entry on
 * the same score as the one before it takes that entry's rank, and the next
 * distinct score picks up where the offsets would have put it ("1, 1, 3").
 */
const shareRanks = (entries: RankedEntry[]): RankedEntry[] => {
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].score === entries[i - 1].score) {
      entries[i].rank = entries[i - 1].rank;
    }
  }
  return entries;
};

/** ioredis returns WITHSCORES as a flat [member, score, member, score, …]. */
const parseWithScores = (raw: string[], startRank: number): RankedEntry[] => {
  const entries: RankedEntry[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    entries.push({
      userId: fromMember(raw[i]),
      score: Number.parseInt(raw[i + 1], 10),
      rank: startRank + i / 2,
    });
  }
  return entries;
};

/** ioredis resolves EXEC even when an individual command returned an error. */
const execRedisTransaction = async (
  transaction: ChainableCommander,
  label: string,
): Promise<void> => {
  const results = await transaction.exec();
  if (!results) throw new Error(`${label}: Redis transaction was aborted`);

  const errors = results
    .map(([error]) => error)
    .filter((error): error is Error => error instanceof Error);
  if (errors.length > 0) {
    throw new Error(
      `${label}: ${errors.map((error) => error.message).join('; ')}`,
    );
  }
};
