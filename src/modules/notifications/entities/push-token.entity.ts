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

import { User } from '../../users/entities/user.entity';

export enum PushPlatform {
  IOS = 'ios',
  ANDROID = 'android',
}

/**
 * Only ever written after the player taps "Notify me" on the summary screen —
 * registration is the opt-in record, not a side effect of launching the app.
 */
@Entity('push_token')
@Index('ix_push_token_user', ['userId'])
@Check(
  'ck_push_token_timezone_offset',
  '"timezoneOffsetMinutes" BETWEEN -720 AND 840',
)
export class PushToken {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'userId',
    foreignKeyConstraintName: 'fk_push_token_user',
  })
  user?: User;

  @Column({ type: 'enum', enum: PushPlatform })
  platform: PushPlatform;

  @Index('uq_push_token_token', { unique: true })
  @Column({ type: 'varchar', length: 512 })
  token: string;

  /**
   * Minutes east of UTC, as reported by the device. Buckets the nudge job so
   * "tomorrow's challenge" lands in the player's evening, not ours.
   */
  @Column({ type: 'int', default: 0 })
  timezoneOffsetMinutes: number;

  @CreateDateColumn({ type: 'timestamptz' })
  optInAt: Date;

  @Column({ type: 'boolean', default: true })
  active: boolean;
}
