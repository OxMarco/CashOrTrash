import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';

import { Api } from './support/api-client';
import { registerPlayer } from './support/players';
import { createTestApp, resetGameplayState, TestApp } from './support/test-app';
import { waitFor } from './support/wait';

const WEBHOOK_AUTH = 'e2e-webhook-secret-with-at-least-32-characters';
const FREE_ROUNDS = 2;

/**
 * RevenueCat, as far as the server can tell: a subscriber endpoint that
 * answers with whatever each spec says a customer owns, and a record of every
 * call. Real HTTP on loopback, so the client's URL building, auth header and
 * status handling are all on the path.
 */
function startRevenueCatStub() {
  const owned = new Map<string, string | null>();
  const calls: Array<{ method: string; path: string; auth?: string }> = [];

  const server: Server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const path = request.url ?? '';
      calls.push({
        method: request.method ?? '',
        path,
        auth: request.headers.authorization,
      });
      const id = decodeURIComponent(path.split('/').pop() ?? '');
      const entitlements = owned.has(id)
        ? { premium: { expires_date: owned.get(id) } }
        : {};
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ subscriber: { entitlements } }));
    },
  );

  return {
    owned,
    calls,
    listen: () =>
      new Promise<string>((resolve) =>
        server.listen(0, '127.0.0.1', () =>
          resolve(
            `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          ),
        ),
      ),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('freemium', () => {
  const stub = startRevenueCatStub();
  const saved = { ...process.env };
  let ctx: TestApp;
  let api: Api;

  beforeAll(async () => {
    Object.assign(process.env, {
      REVENUECAT_API_URL: await stub.listen(),
      REVENUECAT_SECRET_API_KEY: 'sk_e2e',
      REVENUECAT_WEBHOOK_AUTH: WEBHOOK_AUTH,
      FREE_QUICK_ROUNDS_PER_DAY: String(FREE_ROUNDS),
    });
    ctx = await createTestApp();
    api = ctx.api;
  });

  beforeEach(async () => {
    await resetGameplayState(ctx);
    stub.owned.clear();
    stub.calls.length = 0;
  });

  afterAll(async () => {
    await ctx?.close();
    await stub.close();
    process.env = saved;
  });

  const quick = (player: Api) =>
    player.post('/v1/sessions', { mode: 'quick', themeSlug: 'everyday-stuff' });

  const webhook = (body: unknown, authorization = WEBHOOK_AUTH) =>
    fetch(`${ctx.baseUrl}/v1/webhooks/revenuecat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify(body),
    });

  it('holds a free player to the daily allowance, with its own slug', async () => {
    const maria = await registerPlayer(api, 'device-billing-maria');

    for (let round = 0; round < FREE_ROUNDS; round += 1) {
      expect((await quick(maria.api)).status).toBe(201);
    }
    const refused = await quick(maria.api);

    expect(refused.status).toBe(402);
    expect(refused.body.type).toBe('free-rounds-exhausted');

    const me = await maria.api.get('/v1/me');
    expect(me.body.billing).toMatchObject({
      premium: false,
      freeQuickRoundsPerDay: FREE_ROUNDS,
      freeQuickRoundsRemaining: 0,
    });
    // The daily is outside the line.
    expect(
      (await maria.api.post('/v1/sessions', { mode: 'daily' })).status,
    ).toBe(201);
  });

  it('unlocks on the webhook, from what RevenueCat says', async () => {
    const sam = await registerPlayer(api, 'device-billing-sam');
    const { billingId } = (await sam.api.get('/v1/me')).body.billing;
    for (let round = 0; round < FREE_ROUNDS; round += 1) await quick(sam.api);

    stub.owned.set(billingId, '2099-01-01T00:00:00Z');
    const response = await webhook({
      event: { type: 'INITIAL_PURCHASE', app_user_id: billingId },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ synced: 1 });
    expect(stub.calls).toContainEqual({
      method: 'GET',
      path: `/v1/subscribers/${billingId}`,
      auth: 'Bearer sk_e2e',
    });
    expect((await sam.api.get('/v1/me')).body.billing).toMatchObject({
      premium: true,
      freeQuickRoundsRemaining: null,
    });
    expect((await quick(sam.api)).status).toBe(201);
  });

  it('refuses a webhook without the shared secret, and changes nothing', async () => {
    const lee = await registerPlayer(api, 'device-billing-lee');
    const { billingId } = (await lee.api.get('/v1/me')).body.billing;
    stub.owned.set(billingId, '2099-01-01T00:00:00Z');

    const response = await webhook(
      { event: { type: 'INITIAL_PURCHASE', app_user_id: billingId } },
      'Bearer guessed',
    );

    expect(response.status).toBe(401);
    expect(stub.calls).toHaveLength(0);
    expect((await lee.api.get('/v1/me')).body.billing.premium).toBe(false);
  });

  it('syncs on request, and a lapsed entitlement reads as free', async () => {
    const ana = await registerPlayer(api, 'device-billing-ana');
    const { billingId } = (await ana.api.get('/v1/me')).body.billing;

    stub.owned.set(billingId, '2099-01-01T00:00:00Z');
    const bought = await ana.api.post('/v1/me/billing/sync');
    expect(bought.status).toBe(200);
    expect(bought.body.premium).toBe(true);

    stub.owned.set(billingId, '2020-01-01T00:00:00Z');
    const lapsed = await ana.api.post('/v1/me/billing/sync');
    expect(lapsed.body).toMatchObject({
      premium: false,
      premiumExpiresAt: null,
      freeQuickRoundsRemaining: FREE_ROUNDS,
    });
  });

  it('erases the RevenueCat customer when the account is deleted', async () => {
    const kim = await registerPlayer(api, 'device-billing-kim');
    const { billingId } = (await kim.api.get('/v1/me')).body.billing;

    expect((await kim.api.del('/v1/me')).status).toBe(204);

    await waitFor(
      () =>
        stub.calls.some(
          (call) =>
            call.method === 'DELETE' &&
            call.path === `/v1/subscribers/${billingId}`,
        ),
      { label: 'the RevenueCat customer deletion' },
    );
  });
});
