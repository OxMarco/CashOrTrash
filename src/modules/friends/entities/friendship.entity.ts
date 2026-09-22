import {
  Check,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';

/**
 * Stored as two rows (one per direction) so the friends leaderboard is a
 * single-column lookup rather than an OR across both sides.
 */
@Entity('friendship')
@Check('ck_friendship_distinct_users', '"userId" <> "friendUserId"')
export class Friendship {
  @PrimaryColumn({ type: 'int' })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'userId',
    foreignKeyConstraintName: 'fk_friendship_user',
  })
  user?: User;

  /**
   * The primary key leads with `userId`, so it serves "my friends" but not the
   * reverse. This index is for the `CASCADE` from `user`: deleting an account
   * has to find every row naming it as the friend, and without it that is a
   * scan of the whole table.
   */
  @Index('ix_friendship_friend_user')
  @PrimaryColumn({ type: 'int' })
  friendUserId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'friendUserId',
    foreignKeyConstraintName: 'fk_friendship_friend',
  })
  friend?: User;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
