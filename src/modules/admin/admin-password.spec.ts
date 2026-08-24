import { hashAdminPassword, verifyAdminPassword } from './admin-password';

describe('admin password', () => {
  it('verifies a password against its own hash', async () => {
    const hash = await hashAdminPassword('correct horse battery staple');
    await expect(
      verifyAdminPassword('correct horse battery staple', hash),
    ).resolves.toBe(true);
  });

  it('refuses a different password', async () => {
    const hash = await hashAdminPassword('correct horse battery staple');
    await expect(
      verifyAdminPassword('correct horse battery stapler', hash),
    ).resolves.toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [first, second] = await Promise.all([
      hashAdminPassword('the same password'),
      hashAdminPassword('the same password'),
    ]);
    expect(first).not.toEqual(second);
    await expect(
      verifyAdminPassword('the same password', second),
    ).resolves.toBe(true);
  });

  it('emits the shape ADMIN_PASSWORD_HASH is validated against', async () => {
    await expect(hashAdminPassword('any password at all')).resolves.toMatch(
      /^[0-9a-f]{32}:[0-9a-f]{128}$/,
    );
  });

  // The unconfigured-portal path. These must be a plain `false` and never a
  // throw: a 500 here would tell a caller the difference between "no portal on
  // this deployment" and "wrong password".
  it.each([
    ['', 'unset'],
    ['not-a-hash', 'not a pair'],
    ['zz:zz', 'not hex'],
    ['abcd:efgh', 'wrong lengths'],
    [':', 'empty halves'],
  ])('refuses a %s hash (%s) without throwing', async (stored) => {
    await expect(verifyAdminPassword('anything', stored)).resolves.toBe(false);
  });
});
