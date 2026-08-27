import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { Item } from '../../catalog/entities/item.entity';
import { Currency } from '../../currency/currency.constants';
import { GameSession } from './game-session.entity';

/**
 * The composite PK (sessionId, roundIndex) *is* our bet idempotency. A retried
 * request on a flaky connection hits the unique violation, which the service
 * catches and translates into "return the stored result".
 */
@Entity('session_round')
@Check(
  'ck_session_round_values',
  '"roundIndex" >= 0 AND "loCents" >= 0 AND "loCents" < "hiCents" AND "multiplier" > 0 AND "basePoints" >= 0 AND "points" >= 0 AND ("elapsedMs" IS NULL OR "elapsedMs" >= 0) AND (NOT "timedOut" OR "points" = 0)',
)
@Check(
  'ck_session_round_quote',
  `("currency" IS NULL) = ("exchangeRate" IS NULL) AND
   ("exchangeRate" IS NULL OR "exchangeRate" > 0)`,
)
export class SessionRound {
  @PrimaryColumn({ type: 'uuid' })
  sessionId: string;

  @PrimaryColumn({ type: 'int' })
  roundIndex: number;

  @Column({ type: 'int' })
  itemId: number;

  @ManyToOne(() => Item, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'itemId',
    foreignKeyConstraintName: 'fk_session_round_item',
  })
  item?: Item;

  @Column({ type: 'int' })
  loCents: number;

  @Column({ type: 'int' })
  hiCents: number;

  @Column({
    type: 'numeric',
    precision: 5,
    scale: 3,
    transformer: {
      to: (v: number) => v,
      from: (v: string | null) => (v === null ? 0 : Number.parseFloat(v)),
    },
  })
  multiplier: number;

  @Column({ type: 'int' })
  basePoints: number;

  @Column({ type: 'int' })
  points: number;

  @Column({ type: 'boolean' })
  hit: boolean;

  /**
   * The bet arrived after the round's deadline and scored nothing, whatever it
   * contained. Stored rather than re-derived: `roundSeconds` is configuration
   * and can change, and a round already played must keep reading the way it was
   * played.
   */
  @Column({ type: 'boolean', default: false })
  timedOut: boolean;

  /**
   * Server-measured time on the round: `placedAt` minus the moment `/current`
   * dealt it. Null only for a round played before the clock existed, or one
   * whose deal was never stamped. This is the number the timeout was decided
   * on, kept so the decision can be audited after the fact.
   */
  @Column({ type: 'int', nullable: true })
  elapsedMs: number | null;

  /** Signed relative error of the range centre: negative means under-guessed. */
  @Column({ type: 'double precision' })
  errorPct: number;

  /**
   * Which constant set produced `points`. Lets us retune the curve later
   * without invalidating historical leaderboards.
   */
  @Column({ type: 'varchar', length: 16 })
  scoringVersion: string;

  /** The exact quote used to validate and score this bet. */
  @Column({ type: 'varchar', length: 3, nullable: true })
  currency: Currency | null;

  @Column({ type: 'double precision', nullable: true })
  exchangeRate: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  placedAt: Date;

  @ManyToOne(() => GameSession, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'sessionId',
    foreignKeyConstraintName: 'FK_547c9a35166b55a8427af5c3907',
  })
  session?: GameSession;
}
