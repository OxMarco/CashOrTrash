import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Theme } from '../../catalog/entities/theme.entity';
import { Match } from '../../matches/entities/match.entity';
import { User } from '../../users/entities/user.entity';
import { Currency } from '../../currency/currency.constants';

export enum GameMode {
  DAILY = 'daily',
  QUICK = 'quick',
  H2H = 'h2h',
}

export enum SessionStatus {
  ACTIVE = 'active',
  COMPLETE = 'complete',
  ABANDONED = 'abandoned',
}

@Entity('game_session')
@Index('ix_game_session_user_status', ['userId', 'status'])
@Index('ix_game_session_match', ['matchId'])
@Index('uq_session_h2h', ['userId', 'matchId'], {
  unique: true,
  where: `mode = 'h2h' AND "matchId" IS NOT NULL`,
})
// A null `themeId` no longer distinguishes daily from the rest: quick and
// head-to-head are dealt themeless too when the player picks the mystery mix,
// which draws from the whole catalogue rather than from a category. What still
// separates the three modes is the field each one owns — `dailyDate` for the
// calendar's round, `matchId` for a match — so those are what this checks.
@Check(
  'ck_game_session_mode_fields',
  `("mode" = 'daily' AND "dailyDate" IS NOT NULL AND "themeId" IS NULL AND "matchId" IS NULL) OR
   ("mode" = 'quick' AND "dailyDate" IS NULL AND "matchId" IS NULL) OR
   ("mode" = 'h2h' AND "dailyDate" IS NULL AND "matchId" IS NOT NULL)`,
)
@Check(
  'ck_game_session_progress',
  'cardinality("itemIds") > 0 AND "currentIndex" >= 0 AND "currentIndex" <= cardinality("itemIds")',
)
@Check('ck_game_session_score_nonnegative', '"totalScore" >= 0')
@Check(
  'ck_game_session_completion',
  `("status" = 'complete' AND "currentIndex" = cardinality("itemIds") AND "completedAt" IS NOT NULL) OR
   ("status" <> 'complete' AND "completedAt" IS NULL)`,
)
@Check(
  'ck_game_session_slider_bounds',
  `("sliderMinCents" IS NULL) = ("sliderMaxCents" IS NULL) AND
   ("sliderMinCents" IS NULL OR (cardinality("sliderMinCents") = cardinality("itemIds") AND cardinality("sliderMaxCents") = cardinality("itemIds")))`,
)
@Check(
  'ck_game_session_current_quote',
  `("currentCurrency" IS NULL) = ("currentExchangeRate" IS NULL) AND
   ("currentExchangeRate" IS NULL OR "currentExchangeRate" > 0)`,
)
/**
 * One daily attempt per player per day, enforced in the schema rather than in
 * a service check that a concurrent request could slip past.
 */
@Index('uq_session_daily', ['userId', 'dailyDate'], {
  unique: true,
  where: `mode = 'daily'`,
})
export class GameSession {
  /** UUID: session ids appear in URLs, so they must not be enumerable. */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int' })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'userId',
    foreignKeyConstraintName: 'fk_game_session_user',
  })
  user?: User;

  @Column({ type: 'enum', enum: GameMode })
  mode: GameMode;

  @Column({ type: 'int', nullable: true })
  themeId: number | null;

  @ManyToOne(() => Theme, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'themeId',
    foreignKeyConstraintName: 'fk_game_session_theme',
  })
  theme?: Theme | null;

  /**
   * Set only for `mode = daily`. The partial unique index on
   * (userId, dailyDate) is what makes "one attempt per player per day" a
   * database guarantee rather than a service-layer check.
   */
  @Column({ type: 'date', nullable: true })
  dailyDate: string | null;

  @Column({ type: 'uuid', nullable: true })
  matchId: string | null;

  @ManyToOne(() => Match, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'matchId',
    foreignKeyConstraintName: 'fk_game_session_match',
  })
  match?: Match | null;

  @Column({ type: 'int', array: true })
  itemIds: number[];

  /** Immutable slider geometry, aligned with itemIds. Null only on legacy rows. */
  @Column({ type: 'int', array: true, nullable: true })
  sliderMinCents: number[] | null;

  @Column({ type: 'int', array: true, nullable: true })
  sliderMaxCents: number[] | null;

  /** Scoring rules shared by every round in this session. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  scoringVersion: string | null;

  /** Index of the next unplayed round. Equals itemIds.length when complete. */
  @Column({ type: 'int', default: 0 })
  currentIndex: number;

  @Column({ type: 'int', default: 0 })
  totalScore: number;

  @Column({ type: 'enum', enum: SessionStatus, default: SessionStatus.ACTIVE })
  status: SessionStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  /**
   * Stamped when the client fetches `/current`. Backs the optional
   * minimum-time-on-round check against scripted play.
   */
  @Column({ type: 'timestamptz', nullable: true })
  currentServedAt: Date | null;

  /** Currency quote pinned when the current round is first served. */
  @Column({ type: 'varchar', length: 3, nullable: true })
  currentCurrency: Currency | null;

  @Column({ type: 'double precision', nullable: true })
  currentExchangeRate: number | null;
}
