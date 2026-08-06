import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Theme } from './theme.entity';

/**
 * Recomputed hourly by `theme-stats-recompute`. Backs the "Avg ±22%"
 * difficulty labels on the theme picker.
 */
@Entity('theme_stat')
export class ThemeStat {
  @PrimaryColumn({ type: 'int' })
  themeId: number;

  @Column({ type: 'double precision', default: 0 })
  avgErrorPct: number;

  @Column({ type: 'int', default: 0 })
  sampleSize: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToOne(() => Theme, (theme) => theme.stat, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'themeId' })
  theme?: Theme;
}
