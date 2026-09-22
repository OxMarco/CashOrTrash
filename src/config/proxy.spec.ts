import Fastify from 'fastify';

import { trustProxy } from './proxy';

describe('proxy trust boundary', () => {
  const ipFor = async (
    remoteAddress: string,
    forwardedFor?: string,
  ): Promise<string> => {
    const app = Fastify({ trustProxy });
    app.get('/ip', (request) => ({ ip: request.ip }));

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/ip',
        remoteAddress,
        headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
      });
      return response.json().ip;
    } finally {
      await app.close();
    }
  };

  it('uses the address observed by Traefik, not a farther forged hop', async () => {
    // Traefik appends the address it observed (rightmost). Anything farther
    // left came from the caller and must not become request.ip.
    await expect(
      ipFor('172.20.0.2', '203.0.113.10, 198.51.100.7'),
    ).resolves.toBe('198.51.100.7');
  });

  it('accepts the proxy when a dual-stack socket reports it IPv4-mapped', async () => {
    await expect(ipFor('::ffff:172.20.0.2', '198.51.100.7')).resolves.toBe(
      '198.51.100.7',
    );
  });

  /**
   * The reason a bare hop count is no longer enough: a client that reached the
   * port directly could otherwise name any address it liked and spend someone
   * else's budget.
   */
  it('ignores X-Forwarded-For from a peer that is not the proxy', async () => {
    await expect(ipFor('198.51.100.99', '203.0.113.10')).resolves.toBe(
      '198.51.100.99',
    );
  });

  /**
   * Fastify 5.12 fails a numeric `trustProxy` closed. Were that ever what the
   * app ran with, every request would carry Traefik's address and every
   * per-address budget would be shared by the whole player base.
   */
  it('never reports the proxy itself as the client', async () => {
    await expect(ipFor('172.20.0.2', '198.51.100.7')).resolves.not.toBe(
      '172.20.0.2',
    );
  });
});
