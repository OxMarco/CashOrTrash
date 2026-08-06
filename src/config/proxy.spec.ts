import Fastify from 'fastify';

import { TRUST_PROXY_HOPS } from './proxy';

describe('proxy trust boundary', () => {
  it('uses the address observed by Traefik, not a farther forged hop', async () => {
    const app = Fastify({ trustProxy: TRUST_PROXY_HOPS });
    app.get('/ip', (request) => ({ ip: request.ip }));

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/ip',
        remoteAddress: '172.20.0.2',
        headers: {
          // Traefik appends the address it observed (rightmost). Anything
          // farther left came from the caller and must not become request.ip.
          'x-forwarded-for': '203.0.113.10, 198.51.100.7',
        },
      });

      expect(response.json()).toEqual({ ip: '198.51.100.7' });
    } finally {
      await app.close();
    }
  });
});
