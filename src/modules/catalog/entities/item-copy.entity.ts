import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { Item } from './item.entity';

/**
 * One item's prose in one language, for the languages that are not English.
 *
 * English lives on `Item` itself and is the canonical row: the dedupe key, the
 * fallback, and the anchor the translations are written from. See the migration
 * for why the split is that way round rather than a locale column on every row.
 */
@Entity('item_copy')
@Index('ix_item_copy_locale', ['locale'])
@Check('ck_item_copy_not_english', `"locale" <> 'en'`)
export class ItemCopy {
  @Column({ type: 'int', primary: true })
  itemId: number;

  /** A language subtag — `es`, `pt`, `it`. Never region-qualified: the app matches on language. */
  @Column({ type: 'varchar', length: 5, primary: true })
  locale: string;

  @Column({ type: 'varchar', length: 160 })
  title: string;

  @Column({ type: 'varchar', length: 220 })
  conditionLine: string;

  /**
   * When the model wrote it.
   *
   * Not used to decide anything — the import keys off whether a row exists at
   * all. It is here so that "which of these were written before we changed the
   * prompt" is a query rather than a guess, which is the question anyone
   * reviewing generated copy in a language they do not read will want to ask.
   */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  writtenAt: Date;

  // Named, like every other relation in the schema. TypeORM matches a foreign
  // key by *its* generated name, so a migration that names the constraint
  // readably and an entity that does not leaves the schema builder proposing
  // to add a key the table already has — which `migrations.e2e-spec` reads as
  // the drift that breaks a production boot.
  @ManyToOne(() => Item, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'itemId',
    foreignKeyConstraintName: 'fk_item_copy_item',
  })
  item?: Item;
}
