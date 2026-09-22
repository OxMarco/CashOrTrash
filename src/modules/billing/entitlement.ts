import { EntityManager, MoreThanOrEqual } from 'typeorm';

import { fromDateKey, todayUtc } from 'src/common/utils/date.util';
import {
  GameMode,
  GameSession,
} from '../sessions/entities/game-session.entity';
import type { User } from '../users/entities/user.entity';

/**
 * Stored for an entitlement RevenueCat reports with no expiry — a lifetime
 * unlock or a promotional grant. A far-future instant rather than a separate
 * flag, so there is still exactly one question to ask of a player.
 */
export const NEVER_EXPIRES = new Date('9999-12-31T00:00:00.000Z');

/** The whole test. A past expiry is a lapsed subscription, not an error. */
export const isPremium = (
  user: Pick<User, 'premiumExpiresAt'>,
  now: Date = new Date(),
): boolean =>
  user.premiumExpiresAt !== null &&
  user.premiumExpiresAt.getTime() > now.getTime();

/**
 * Quick rounds started since UTC midnight. Every one counts, finished or not:
 * a round is spent when it is dealt, since dealing is what shows the prices.
 */
export const quickRoundsToday = (
  manager: EntityManager,
  userId: number,
  now: Date = new Date(),
): Promise<number> =>
  manager.getRepository(GameSession).count({
    where: {
      userId,
      mode: GameMode.QUICK,
      createdAt: MoreThanOrEqual(fromDateKey(todayUtc(now))),
    },
  });
