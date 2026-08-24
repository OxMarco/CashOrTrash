import { UserThrottlerGuard } from './user-throttler.guard';

/**
 * The guard's whole job is one string. Instantiated directly rather than
 * through a testing module — the base class only needs its three constructor
 * arguments to exist, and `getTracker` touches none of them.
 */
describe('UserThrottlerGuard', () => {
  const stub = {} as never;
  const guard = new UserThrottlerGuard(stub, stub, stub);

  // `getTracker` is protected; the test is the caller the class exists for.
  const trackerFor = (req: Record<string, unknown>): Promise<string> =>
    (
      guard as unknown as {
        getTracker(req: Record<string, unknown>): Promise<string>;
      }
    ).getTracker(req);

  it('charges an authenticated request to its account', async () => {
    await expect(
      trackerFor({ user: { id: 7, username: 'sam' }, ip: '1.2.3.4' }),
    ).resolves.toBe('user:7');
  });

  /**
   * Two players on one office connection must not share a budget — that is the
   * bug this guard exists to fix, and the reason the account wins over the
   * address whenever both are present.
   */
  it('separates two accounts arriving from the same address', async () => {
    const [a, b] = await Promise.all([
      trackerFor({ user: { id: 7 }, ip: '1.2.3.4' }),
      trackerFor({ user: { id: 8 }, ip: '1.2.3.4' }),
    ]);

    expect(a).not.toBe(b);
  });

  it('falls back to the address when there is no account yet', async () => {
    await expect(trackerFor({ ip: '1.2.3.4' })).resolves.toBe('ip:1.2.3.4');
  });

  it('does not confuse an account key with an address key', async () => {
    const asUser = await trackerFor({ user: { id: 7 } });
    const asIp = await trackerFor({ ip: '7' });

    expect(asUser).not.toBe(asIp);
  });

  it('still produces a key when the address is unresolvable', async () => {
    await expect(trackerFor({})).resolves.toBe('ip:unknown');
  });
});
