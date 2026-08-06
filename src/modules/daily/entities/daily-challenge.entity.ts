import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * "Same items for everyone." Generated a day ahead by `daily-challenge-gen`
 * from a deterministic seed so the set is reproducible and auditable.
 */
@Entity('daily_challenge')
export class DailyChallenge {
  /** UTC calendar date, `YYYY-MM-DD`. */
  @PrimaryColumn({ type: 'date' })
  challengeDate: string;

  @Column({ type: 'int', array: true })
  itemIds: number[];

  /** The seed the generator used — makes a set reproducible after the fact. */
  @Column({ type: 'varchar', length: 64 })
  seed: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
