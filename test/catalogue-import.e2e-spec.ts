import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CatalogImportService } from '../src/modules/catalog/import/catalog-import.service';
import { createTestApp, TestApp } from './support/test-app';

/**
 * The import against a real database, driven the way an operator drives it:
 * by changing files.
 *
 * The whole delivery story is "drop files in, redeploy", so what these assert
 * is that the tree and the catalogue stay reconciled across the four things
 * that can happen to a file — it appears, it is repriced, it is deleted, it
 * comes back. The unit specs cover parsing and icons; this covers the part that
 * needs Postgres to be true.
 *
 * No `OPENAI_API_KEY` is set for the suite, so this runs the fallback path and
 * makes no network calls. What the copywriter would have written is its own
 * concern; that it is *optional* is this one's.
 */
describe('importing the catalogue from a directory tree', () => {
  let ctx: TestApp;
  let importer: CatalogImportService;
  let itemsRoot: string;

  /** A real photograph, since the import decodes it for real. */
  const CATALOGUE = join(__dirname, '..', 'items', 'watches');
  const SPEEDMASTER = 'omega speedmaster_1150.webp';
  const SNOOPY = 'omega snoopy_14175.webp';

  const place = (file: string, as = file) =>
    copyFileSync(join(CATALOGUE, file), join(itemsRoot, 'fixture-watches', as));

  const rows = () =>
    ctx.dataSource.query(
      `SELECT i.title, i."truePriceCents", i.active, i."sourceName", i."sourceHash"
         FROM item i JOIN theme t ON t.id = i."themeId"
        WHERE t.slug = 'fixture-watches'
        ORDER BY i.id`,
    );

  beforeAll(async () => {
    itemsRoot = mkdtempSync(join(tmpdir(), 'cot-import-e2e-'));
    mkdirSync(join(itemsRoot, 'fixture-watches'));
    writeFileSync(join(itemsRoot, 'fixture-watches', 'icon.txt'), 'gem\n');
    place(SPEEDMASTER);

    // Read when the config factory runs, so it has to be set before the app is
    // built. A directory of its own, not the repository's — a spec that renamed
    // and deleted the real catalogue would be a bad afternoon.
    process.env.ITEMS_ROOT = itemsRoot;

    ctx = await createTestApp();
    importer = ctx.app.get(CatalogImportService);
  });

  afterAll(async () => {
    // The catalogue is not part of `resetGameplayState`, and the specs that run
    // after this one assert on the theme list. Take the rows away again.
    await ctx?.dataSource.query(
      `DELETE FROM item WHERE "themeId" IN (SELECT id FROM theme WHERE slug = 'fixture-watches')`,
    );
    await ctx?.dataSource.query(
      `DELETE FROM theme WHERE slug = 'fixture-watches'`,
    );
    await ctx?.close();
    delete process.env.ITEMS_ROOT;
    rmSync(itemsRoot, { recursive: true, force: true });
  });

  it('creates the category and its items from the folder', async () => {
    const report = await importer.run();

    expect(report.created).toBe(1);
    const [item] = await rows();
    expect(item.title).toBe('Omega Speedmaster');
    expect(item.truePriceCents).toBe(115_000);
    expect(item.active).toBe(true);
    expect(item.sourceName).toBe(`fixture-watches/${SPEEDMASTER}`);

    const [theme] = await ctx.dataSource.query(
      `SELECT name, "iconName" FROM theme WHERE slug = 'fixture-watches'`,
    );
    // Hyphens and underscores become spaces, and only the first word is
    // capitalised — these are labels on a card, not headlines.
    expect(theme).toMatchObject({ name: 'Fixture watches', iconName: 'gem' });
  });

  /**
   * The one that makes redeploying cheap. A second run must not decode a
   * photograph, call a model, or write a row — an image already imported costs
   * a hash and an indexed lookup.
   */
  it('does nothing at all on a second run', async () => {
    const before = await rows();
    const report = await importer.run();

    expect(report).toMatchObject({ created: 0, updated: 0, deactivated: 0 });
    expect(report.skipped).toBe(1);
    expect(await rows()).toEqual(before);
  });

  it('imports only what is new when a file is added', async () => {
    place(SNOOPY);
    const report = await importer.run();

    expect(report).toMatchObject({ created: 1, skipped: 1 });
    expect(await rows()).toHaveLength(2);
  });

  /**
   * The photograph is the identity, so renaming one is never a new item. This
   * is the path the EUR→USD repricing took.
   */
  it('rewrites the price in place when a file is renamed', async () => {
    renameSync(
      join(itemsRoot, 'fixture-watches', SPEEDMASTER),
      join(itemsRoot, 'fixture-watches', 'omega speedmaster_1250.webp'),
    );

    const report = await importer.run();

    expect(report).toMatchObject({ created: 0, updated: 1 });
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all[0].truePriceCents).toBe(125_000);
  });

  it('retires an item whose file is deleted, without deleting the row', async () => {
    rmSync(join(itemsRoot, 'fixture-watches', SNOOPY));

    const report = await importer.run();

    expect(report.deactivated).toBe(1);
    const all = await rows();
    // Still two rows: `session_round` references items with onDelete RESTRICT,
    // so a played item cannot be removed and a scoreboard cannot lose the round
    // it was built from.
    expect(all).toHaveLength(2);
    expect(
      all.find((r: { sourceName: string }) => r.sourceName.includes('snoopy'))
        .active,
    ).toBe(false);
  });

  it('brings it back when the file returns, rather than duplicating it', async () => {
    place(SNOOPY);

    const report = await importer.run();

    expect(report.created).toBe(0);
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all.every((r: { active: boolean }) => r.active)).toBe(true);
  });

  it('refuses an item too cheap to carry a playable slider', async () => {
    place(SNOOPY, 'omega snoopy cheap_3.webp');

    const report = await importer.run();

    expect(report.created).toBe(0);
    expect(report.rejected.join('\n')).toContain('under the $20 minimum');
    rmSync(join(itemsRoot, 'fixture-watches', 'omega snoopy cheap_3.webp'));
  });

  it('warns rather than fails when icon.txt names a glyph the app lacks', async () => {
    writeFileSync(
      join(itemsRoot, 'fixture-watches', 'icon.txt'),
      'submarine\n',
    );

    const report = await importer.run();

    expect(report.warnings.join('\n')).toContain('does not ship');
    const [theme] = await ctx.dataSource.query(
      `SELECT "iconName" FROM theme WHERE slug = 'fixture-watches'`,
    );
    expect(theme.iconName).toBe('basket');

    writeFileSync(join(itemsRoot, 'fixture-watches', 'icon.txt'), 'gem\n');
  });
});
