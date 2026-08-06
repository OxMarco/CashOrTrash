import { CatalogService } from '../src/modules/catalog/catalog.service';
import { Api } from './support/api-client';
import { registerPlayer } from './support/players';
import { createTestApp, TestApp } from './support/test-app';

/**
 * The freshness contract the app's persisted cache depends on.
 *
 * What matters is not the value of a version but its *behaviour*: it must hold
 * still while the server would send the same bytes, and move as soon as it
 * would not. A version that drifts on its own makes every launch refetch; one
 * that sticks leaves a category on the picker that nobody can play.
 */
describe('the cache manifest', () => {
  let ctx: TestApp;
  let api: Api;
  let player: Awaited<ReturnType<typeof registerPlayer>>;

  const manifest = async () => {
    const response = await player.api.get('/v1/manifest');
    expect(response.status).toBe(200);
    return response.body as { catalog: string; currency: string };
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    api = ctx.api;
    player = await registerPlayer(api, 'manifest-device-0001', 'versioned');
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('needs a session, like every other cached resource', async () => {
    expect((await api.get('/v1/manifest')).status).toBe(401);
  });

  it('publishes an opaque version per cacheable resource', async () => {
    const body = await manifest();

    expect(body.catalog).toMatch(/^[0-9a-f]{16}$/);
    expect(body.currency).toMatch(/^[0-9a-f]{16}$/);
    expect(body.catalog).not.toBe(body.currency);
  });

  it('holds still while nothing changes', async () => {
    const first = await manifest();
    const second = await manifest();

    expect(second).toEqual(first);
  });

  /**
   * The case the whole mechanism exists for. A category crossing the item
   * count it needs to be offered changes the picker without any client having
   * asked for anything, and `staleTime` alone would leave installed apps
   * showing the old grid for as long as it lasts.
   *
   * Note where the version moves, because it is earlier than it looks: adding
   * an item to a category too small to be offered still moves it. The mystery
   * row advertises `itemCount` for the *whole* catalogue, so every item is on
   * the picker somewhere and there is no such thing as an invisible addition.
   * That is the version tracking the payload exactly, which is the property
   * being relied on — not an over-eager trigger.
   */
  it('moves when the picker a client would be served changes', async () => {
    const before = await manifest();

    const catalog = ctx.app.get(CatalogService);
    const [theme] = await ctx.dataSource.query(
      `INSERT INTO theme (slug, name, "iconName", "sortOrder", "isMystery", "bonusPct", active)
       VALUES ('manifest-probe', 'Manifest probe', 'gem', 50, false, 0, true)
       RETURNING id`,
    );

    // An empty category is not offered and is not counted, so nothing a client
    // sees has changed yet.
    await catalog.invalidateThemes();
    expect((await manifest()).catalog).toBe(before.catalog);

    // Four items: still short of `ROUNDS_PER_SESSION`, so the category itself
    // stays off the picker — but the mystery row's count moves, so the version
    // does too.
    await ctx.dataSource.query(
      `INSERT INTO item (title, "conditionLine", "photoUrl", "truePriceCents",
                         "themeId", origin, active)
       SELECT 'Probe ' || n, 'probe', '/media/items/x.webp', 10000 * n,
              $1, 'import', true
         FROM generate_series(1, 4) AS n`,
      [theme.id],
    );
    await catalog.invalidateThemes();

    const hidden = await manifest();
    expect(hidden.catalog).not.toBe(before.catalog);
    expect(
      (await player.api.get('/v1/themes')).body.map(
        (t: { slug: string }) => t.slug,
      ),
    ).not.toContain('manifest-probe');

    // The fifth item is what makes it playable, and therefore visible.
    await ctx.dataSource.query(
      `INSERT INTO item (title, "conditionLine", "photoUrl", "truePriceCents",
                         "themeId", origin, active)
       VALUES ('Probe 5', 'probe', '/media/items/x.webp', 50000, $1, 'import', true)`,
      [theme.id],
    );
    await catalog.invalidateThemes();

    const after = await manifest();
    expect(after.catalog).not.toBe(hidden.catalog);
    expect(
      (await player.api.get('/v1/themes')).body.map(
        (t: { slug: string }) => t.slug,
      ),
    ).toContain('manifest-probe');
    // Only the resource that changed moves — a client refetching everything on
    // any change would be no better than no manifest at all.
    expect(after.currency).toBe(before.currency);

    await ctx.dataSource.query(`DELETE FROM item WHERE "themeId" = $1`, [
      theme.id,
    ]);
    await ctx.dataSource.query(`DELETE FROM theme WHERE id = $1`, [theme.id]);
    await catalog.invalidateThemes();

    // Back to exactly the version it started on, which is the property that
    // makes "unchanged" trustworthy: the version is derived from the payload,
    // not from a counter or a clock that only ever climbs. A monotonic scheme
    // would report a change here and send every client to refetch a picker
    // identical to the one they already hold.
    expect((await manifest()).catalog).toBe(before.catalog);
  });
});
