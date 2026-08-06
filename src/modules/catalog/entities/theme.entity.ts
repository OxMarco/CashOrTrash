import {
  Check,
  Column,
  Entity,
  Index,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { ThemeStat } from './theme-stat.entity';

@Entity('theme')
@Check('ck_theme_bonus_pct_range', '"bonusPct" >= 0 AND "bonusPct" <= 1')
export class Theme {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('uq_theme_slug', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  slug: string;

  @Column({ type: 'varchar', length: 64 })
  name: string;

  /**
   * Which glyph the picker card draws. A name from a fixed set the client
   * ships, not a URL — see THEME_ICONS for why the set is closed.
   */
  @Column({ type: 'varchar', length: 32, default: 'basket' })
  iconName: string;

  /** Ascending; ties fall back to id. Lets an admin reorder the picker grid. */
  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  /** "Mystery mix" draws from every theme and carries the bonus. */
  @Column({ type: 'boolean', default: false })
  isMystery: boolean;

  /** 0.10 == +10% points. Applied multiplicatively in ScoringService. */
  @Column({
    type: 'numeric',
    precision: 4,
    scale: 3,
    default: 0,
    transformer: {
      to: (v: number) => v,
      from: (v: string | null) => (v === null ? 0 : Number.parseFloat(v)),
    },
  })
  bonusPct: number;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @OneToOne(() => ThemeStat, (stat) => stat.theme)
  stat?: ThemeStat;
}
