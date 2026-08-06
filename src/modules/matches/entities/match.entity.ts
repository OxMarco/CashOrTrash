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
import { User } from '../../users/entities/user.entity';

export enum MatchStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  COMPLETE = 'complete',
}

@Entity('match')
@Check('ck_match_items', 'cardinality("itemIds") > 0')
@Check(
  'ck_match_players',
  '"guestUserId" IS NULL OR "hostUserId" <> "guestUserId"',
)
@Check('ck_match_scores', '"hostScore" >= 0 AND "guestScore" >= 0')
@Check(
  'ck_match_winner',
  '"winnerUserId" IS NULL OR "winnerUserId" = "hostUserId" OR "winnerUserId" = "guestUserId"',
)
@Check(
  'ck_match_status_fields',
  `("status" = 'pending' AND "guestUserId" IS NULL AND "completedAt" IS NULL AND "winnerUserId" IS NULL) OR
   ("status" = 'active' AND "guestUserId" IS NOT NULL AND "completedAt" IS NULL AND "winnerUserId" IS NULL) OR
   ("status" = 'complete' AND "guestUserId" IS NOT NULL AND "completedAt" IS NOT NULL)`,
)
export class Match {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int', array: true })
  itemIds: number[];

  @Column({ type: 'int' })
  themeId: number;

  @ManyToOne(() => Theme, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'themeId', foreignKeyConstraintName: 'fk_match_theme' })
  theme?: Theme;

  /** Short, human-shareable, unambiguous alphabet. Carried in the deep link. */
  @Index('uq_match_invite_code', { unique: true })
  @Column({ type: 'varchar', length: 12 })
  inviteCode: string;

  @Column({ type: 'int' })
  hostUserId: number;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'hostUserId',
    foreignKeyConstraintName: 'fk_match_host_user',
  })
  hostUser?: User;

  @Column({ type: 'int', nullable: true })
  guestUserId: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'guestUserId',
    foreignKeyConstraintName: 'fk_match_guest_user',
  })
  guestUser?: User | null;

  @Column({ type: 'enum', enum: MatchStatus, default: MatchStatus.PENDING })
  status: MatchStatus;

  @Column({ type: 'int', default: 0 })
  hostScore: number;

  @Column({ type: 'int', default: 0 })
  guestScore: number;

  /** Null on a draw as well as while in progress — read with `status`. */
  @Column({ type: 'int', nullable: true })
  winnerUserId: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'winnerUserId',
    foreignKeyConstraintName: 'fk_match_winner_user',
  })
  winnerUser?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;
}
