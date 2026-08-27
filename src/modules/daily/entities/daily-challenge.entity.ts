import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
} from 'typeorm';

/**
 * "Same items for everyone." Generated a day ahead by `daily-challenge-gen`
 * from a deterministic seed so the set is reproducible and auditable.
 */
@Entity('daily_challenge')
@Check(
  'ck_daily_challenge_slider_bounds',
  `("sliderMinCents" IS NULL) = ("sliderMaxCents" IS NULL) AND
   ("sliderMinCents" IS NULL OR (cardinality("sliderMinCents") = cardinality("itemIds") AND cardinality("sliderMaxCents") = cardinality("itemIds")))`,
)
export class DailyChallenge {
  /** UTC calendar date, `YYYY-MM-DD`. */
  @PrimaryColumn({ type: 'date' })
  challengeDate: string;

  @Column({ type: 'int', array: true })
  itemIds: number[];

  @Column({ type: 'int', array: true, nullable: true })
  sliderMinCents: number[] | null;

  @Column({ type: 'int', array: true, nullable: true })
  sliderMaxCents: number[] | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  scoringVersion: string | null;

  /** The seed the generator used — makes a set reproducible after the fact. */
  @Column({ type: 'varchar', length: 64 })
  seed: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
