import { HealthCheckError } from '@nestjs/terminus';

import { CatalogHealthIndicator } from './catalog.health';

const config = () =>
  ({
    getOrThrow: () => ({ roundsPerSession: 5 }),
  }) as never;

function repositories({ themeCount = 5, itemsPerTheme = 5 } = {}) {
  const themes = Array.from({ length: themeCount }, (_, index) => ({
    id: index + 1,
  }));
  const items = themes.flatMap((theme, themeIndex) =>
    Array.from({ length: itemsPerTheme }, (_, itemIndex) => ({
      id: themeIndex * itemsPerTheme + itemIndex + 1,
      themeId: theme.id,
    })),
  );
  return {
    items: { find: jest.fn().mockResolvedValue(items) } as never,
    themes: { find: jest.fn().mockResolvedValue(themes) } as never,
  };
}

describe('catalogue readiness', () => {
  it('accepts a catalogue with enough playable themes', async () => {
    const repos = repositories();
    const indicator = new CatalogHealthIndicator(
      repos.items,
      repos.themes,
      config(),
    );

    await expect(indicator.isHealthy('catalogue')).resolves.toMatchObject({
      catalogue: { status: 'up', importedItems: 25, playableThemes: 5 },
    });
  });

  it.each([
    [{ themeCount: 4 }, 'too few themes'],
    // A theme short of a full round is not playable, so five half-filled
    // categories are still an unready catalogue rather than five ready ones.
    [{ itemsPerTheme: 4 }, 'no theme holding a full round'],
  ])('refuses a catalogue with %s', async (options, _label) => {
    const repos = repositories(options);
    const indicator = new CatalogHealthIndicator(
      repos.items,
      repos.themes,
      config(),
    );

    await expect(indicator.isHealthy('catalogue')).rejects.toBeInstanceOf(
      HealthCheckError,
    );
  });

  /**
   * An unreachable database reaches this indicator as a driver error, and
   * Terminus only treats HealthCheckError as a failed check. Letting the raw
   * one escape answers /health/ready with a bare 500 instead of a 503 naming
   * the dependency — which is the whole point of the probe, and what an
   * external uptime alert is pointed at.
   */
  it('reports a database it cannot read as a failed check, not an exception', async () => {
    const repos = repositories();
    const unreachable = {
      find: jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:5432')),
    } as never;
    const indicator = new CatalogHealthIndicator(
      unreachable,
      repos.themes,
      config(),
    );

    const failure = await indicator
      .isHealthy('catalogue')
      .then(() => null)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HealthCheckError);
    expect((failure as HealthCheckError).causes).toMatchObject({
      catalogue: { status: 'down', message: 'ECONNREFUSED 127.0.0.1:5432' },
    });
  });
});
