import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('user')
@Check(
  'ck_user_stats_nonnegative',
  '"totalPoints" >= 0 AND "streakDays" >= 0 AND "bestRoundScore" >= 0',
)
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * Claimed after onboarding, so nullable until then. `citext` gives us
   * case-insensitive uniqueness in the database rather than in a service —
   * "Sam" and "sam" collide at the index, which is what makes the username
   * race in the e2e test resolve deterministically.
   */
  @Index('uq_user_username', { unique: true, where: '"username" IS NOT NULL' })
  @Column({ type: 'citext', nullable: true })
  username: string | null;

  @Index('uq_user_device_id', { unique: true })
  @Column({ type: 'varchar', length: 128 })
  deviceId: string;

  /** Drives the client-side generated avatar; no image upload in v1. */
  @Column({ type: 'varchar', length: 32 })
  avatarSeed: string;

  @Column({ type: 'int', default: 0 })
  totalPoints: number;

  @Column({ type: 'int', default: 0 })
  streakDays: number;

  /** UTC calendar date of the last completed daily session. */
  @Column({ type: 'date', nullable: true })
  streakLastPlayedOn: string | null;

  @Column({ type: 'int', default: 0 })
  bestRoundScore: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
