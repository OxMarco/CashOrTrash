import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';

/**
 * Postgres is authoritative for the leaderboard; the Redis ZSETs are a serving
 * layer rebuilt from this table by `leaderboard-rebuild`.
 */
@Entity('daily_score')
@Index('ix_daily_score_date_score', ['challengeDate', 'score'])
@Check(
  'ck_daily_score_values',
  '"score" >= 0 AND ("rank" IS NULL OR "rank" > 0)',
)
export class DailyScore {
  @PrimaryColumn({ type: 'int' })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'userId',
    foreignKeyConstraintName: 'fk_daily_score_user',
  })
  user?: User;

  @PrimaryColumn({ type: 'date' })
  challengeDate: string;

  @Column({ type: 'int' })
  score: number;

  /** Final standing written by the nightly snapshot. */
  @Column({ type: 'int', nullable: true })
  rank: number | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
