/**
 * Terminus's per-dependency map, cut down to what a stranger may see.
 *
 * `/health/ready` is public — it has to be, for an uptime monitor — and each
 * indicator's details are written for an operator: a driver error naming the
 * database host, a Redis `ECONNREFUSED` with its address and port, the reason
 * the newest maintenance job failed. None of that tells a monitor anything it
 * needs, and all of it is reconnaissance for someone probing the stack. The
 * public body keeps each dependency's name and whether it is up; the rest is
 * logged server-side by `AllExceptionsFilter` when the probe fails.
 */
export function redactHealthDetails(
  map: unknown,
): Record<string, { status: 'up' | 'down' }> {
  if (typeof map !== 'object' || map === null) return {};
  return Object.fromEntries(
    Object.entries(map).map(([name, detail]) => [
      name,
      {
        status:
          typeof detail === 'object' &&
          detail !== null &&
          (detail as { status?: unknown }).status === 'up'
            ? 'up'
            : 'down',
      },
    ]),
  );
}
