import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTestApp, TestApp } from './support/test-app';

describe('admin portal API', () => {
  let ctx: TestApp;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    const login = await ctx.api.post('/admin/api/session', {
      password: 'test-admin-password',
    });
    expect(login.status).toBe(201);
    token = login.body.token;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const adminRequest = async (path: string, method: string, body?: unknown) =>
    fetch(`${ctx.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('guards catalogue data and validates the login body', async () => {
    expect((await ctx.api.get('/admin/api/categories')).status).toBe(401);
    expect(
      (
        await ctx.api.post('/admin/api/session', {
          password: 'test-admin-password',
          unexpected: true,
        })
      ).status,
    ).toBe(400);
  });

  it('rejects malformed category mutations instead of coercing them', async () => {
    expect(
      (
        await adminRequest('/admin/api/categories', 'POST', {
          name: 'x'.repeat(65),
          iconName: 'not-an-icon',
        })
      ).status,
    ).toBe(400);

    const [{ id }] = await ctx.dataSource.query(
      'SELECT id FROM theme ORDER BY id LIMIT 1',
    );
    expect(
      (
        await adminRequest(`/admin/api/categories/${id}`, 'PATCH', {
          active: 'false',
        })
      ).status,
    ).toBe(400);
  });

  it('validates multipart fields before cataloguing the photograph', async () => {
    const [{ id }] = await ctx.dataSource.query(
      'SELECT id FROM theme ORDER BY id LIMIT 1',
    );
    const photo = await readFile(
      join(__dirname, '..', 'assets', 'photo-pending.webp'),
    );
    const form = new FormData();
    form.set('themeId', String(id));
    form.set('title', 'x'.repeat(121));
    form.set('conditionLine', 'Good condition');
    form.set('priceCents', '2500');
    form.set('sourceUrl', 'javascript:alert(1)');
    form.set('photo', new Blob([photo], { type: 'image/webp' }), 'photo.webp');

    const response = await fetch(`${ctx.baseUrl}/admin/api/items`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });

    expect(response.status).toBe(400);
  });
});
