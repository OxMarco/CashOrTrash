import { Exclude } from 'class-transformer';
import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Theme } from './theme.entity';

/** Where a row came from, and therefore how disposable it is. */
export enum ItemOrigin {
  /** The hand-authored placeholder catalogue. Retired once real items exist. */
  SEED = 'seed',
  /**
   * Historical. Nothing writes this any more — the crawlers and their review
   * queue were removed in favour of adding items by hand. Kept so that rows
   * predating that still read back, and so the enum value need not be dropped
   * from a live type.
   */
  CRAWLER = 'crawler',
  /** Entered in the admin portal. The only writer today. */
  MANUAL = 'manual',
  /**
   * Historical. Imported from an `items/` tree on boot, back when shipping the
   * catalogue meant shipping files. Kept for the same reason as CRAWLER: rows
   * predating the portal still read back.
   */
  IMPORT = 'import',
}

@Entity('item')
@Index('ix_item_theme_active', ['themeId', 'active'])
// Two items with the same title in the same category are a duplicate, not a
// pair. Titles are written by a model now, so this is also the backstop that
// catches two different objects being described identically — see
// `ItemCopyService`, which qualifies a clashing title rather than dropping the
// item.
@Index('uq_item_theme_title', ['themeId', 'title'], { unique: true })
// The photograph is the item's identity, so importing the same file twice is an
// update and never a second row. Keyed on the *source* bytes rather than the
// washed derivative: the derivative changes whenever the processing does, and a
// sharp upgrade should not re-import the entire catalogue.
@Index('uq_item_source_hash', ['sourceHash'], {
  unique: true,
  where: '"sourceHash" IS NOT NULL',
})
@Check('ck_item_true_price_positive', '"truePriceCents" > 0')
export class Item {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 120 })
  title: string;

  /** "Lightly used · aluminium base · 2019" */
  @Column({ type: 'varchar', length: 160 })
  conditionLine: string;

  /**
   * sha256 of the file this row was imported from, and the key the import
   * decides skip-or-write on. Null only on rows that predate the import.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  sourceHash: string | null;

  /**
   * Its path under `items/`, e.g. `watches/rolex daytona 2016_20600.webp`.
   *
   * Carries the price and the category, so comparing it against the file on
   * disk is how a rename is noticed: the same bytes under a new price get the
   * price rewritten, and under new prose get the copy rewritten, neither of
   * which is a new item.
   */
  @Column({ type: 'varchar', length: 256, nullable: true })
  sourceName: string | null;

  /** Points at the washed derivative, not the original that was fetched. */
  @Column({ type: 'varchar', length: 512 })
  photoUrl: string;

  /**
   * The secret. Layer 1 of 3 guarding it — see IMPLEMENTATION_PLAN §1.
   * Layers 2 and 3 are `excludeExtraneousValues` on the global serializer and
   * the fact that controllers only ever return response DTOs.
   */
  @Exclude()
  @Column({ type: 'int' })
  truePriceCents: number;

  // Slider bounds live on the challenge/match/session, never on the item. They
  // vary per play, but are pinned before the play starts so a secret rotation
  // cannot alter an in-flight round — see `slider.ts`.

  @Column({ type: 'int' })
  themeId: number;

  /**
   * Where the price was found, if whoever added the item recorded it. Optional
   * and free-form — it is a note to the operator, not a gate — and it never
   * leaves the server.
   */
  @Exclude()
  @Column({ type: 'varchar', length: 512, nullable: true })
  sourceUrl: string | null;

  /**
   * Makes the placeholder catalogue disposable: retiring it once real content
   * exists is one UPDATE keyed on this, not a list of ids someone maintains.
   */
  @Column({ type: 'enum', enum: ItemOrigin, default: ItemOrigin.SEED })
  origin: ItemOrigin;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  /**
   * Whether the model still owes this item its prose.
   *
   * An upload returns as soon as the photograph is stored, so `title` and
   * `conditionLine` start out holding the text typed into the portal and the
   * copy job replaces them. Flagged rather than inferred: once the model has
   * run there is nothing about the stored English that distinguishes prose it
   * wrote from prose that happened to read well, so a job that had to guess
   * would either re-bill every item on every run or never retry a failure.
   *
   * Items are dealt while it is true. Typed-in text is a worse description than
   * a written one, but it is a correct one — holding the item back would make a
   * category unplayable for as long as OpenAI was down.
   */
  @Column({ type: 'boolean', default: false })
  copyPending: boolean;

  @ManyToOne(() => Theme, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'themeId',
    foreignKeyConstraintName: 'FK_3e027a2b5a133ad5d97ef28d155',
  })
  theme?: Theme;
}
