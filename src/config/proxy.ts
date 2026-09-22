import { BlockList, isIPv6 } from 'node:net';

/** The production app has exactly one trusted front-facing proxy: Traefik. */
const TRUST_PROXY_HOPS = 1;

/**
 * Where that proxy can be. Traefik reaches the app over the compose network,
 * which Docker allocates from private space; the app publishes no port, so no
 * other peer on a private address exists. Loopback covers local runs and the
 * e2e suite, which connects over 127.0.0.1.
 */
const PROXY_NETWORKS = new BlockList();
PROXY_NETWORKS.addSubnet('10.0.0.0', 8, 'ipv4');
PROXY_NETWORKS.addSubnet('172.16.0.0', 12, 'ipv4');
PROXY_NETWORKS.addSubnet('192.168.0.0', 16, 'ipv4');
PROXY_NETWORKS.addSubnet('127.0.0.0', 8, 'ipv4');
PROXY_NETWORKS.addSubnet('fc00::', 7, 'ipv6');
PROXY_NETWORKS.addAddress('::1', 'ipv6');

const IPV4_MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

const isProxyPeer = (address: string): boolean => {
  // A dual-stack socket reports an IPv4 peer as `::ffff:a.b.c.d`.
  const mapped = IPV4_MAPPED.exec(address);
  if (mapped) return PROXY_NETWORKS.check(mapped[1], 'ipv4');
  return PROXY_NETWORKS.check(address, isIPv6(address) ? 'ipv6' : 'ipv4');
};

/**
 * Fastify's `trustProxy`: which hops may speak for the client.
 *
 * A bare hop count (`trustProxy: 1`) used to mean "trust the immediate peer,
 * whoever it is". Fastify 5.12 made a number fail closed instead — it cannot
 * tell the proxy from a client that reached the port directly and brought its
 * own `X-Forwarded-For` — so with a number every request would take Traefik's
 * address as `request.ip`, and every per-address budget (account minting, the
 * admin login, the anonymous throttle) would become one budget shared by every
 * player at once.
 *
 * So the one hop is trusted only when it comes from where Traefik can be.
 * `hop` is 0 for the socket peer: trusting that one hop selects the address
 * Traefik observed and appended (the rightmost `X-Forwarded-For` entry), and
 * nothing a caller injected farther left is ever reached.
 */
export const trustProxy = (address: string, hop: number): boolean =>
  hop < TRUST_PROXY_HOPS && isProxyPeer(address);
