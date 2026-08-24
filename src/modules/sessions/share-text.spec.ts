import { GameMode } from './entities/game-session.entity';
import { buildShareText } from './share-text';

const ORIGIN = 'https://cashortrash.fun';

type Session = Parameters<typeof buildShareText>[0];

const session = (overrides: Partial<Session> = {}): Session => ({
  mode: GameMode.QUICK,
  dailyDate: null,
  itemIds: [1, 2, 3, 4, 5],
  totalScore: 1112,
  ...overrides,
});

const rounds = (...hits: boolean[]) => hits.map((hit) => ({ hit }));

describe('buildShareText', () => {
  it('draws the round as squares rather than as prices', () => {
    const text = buildShareText(
      session(),
      rounds(true, false, true, false, false),
      2,
      ORIGIN,
    );

    // The whole point of the grid: it says how the game went without telling
    // anyone reading it what today's items were worth.
    expect(text).toContain('🟩⬜🟩⬜⬜');
    expect(text).not.toContain('1112');
    expect(text).toContain('2/5');
    expect(text).toContain('+1,112');
  });

  it('dates a daily, so two days of results do not read as one', () => {
    const text = buildShareText(
      session({ mode: GameMode.DAILY, dailyDate: '2026-08-23' }),
      rounds(true, true, true, true, true),
      5,
      ORIGIN,
    );

    expect(text).toContain('CashOrTrash · daily 2026-08-23');
  });

  it('leaves a quick round undated, because it is nobody else’s five items', () => {
    const text = buildShareText(session(), rounds(true), 1, ORIGIN);

    expect(text).toContain('CashOrTrash');
    expect(text).not.toMatch(/daily/);
  });

  it('gives the grid somewhere to point', () => {
    const text = buildShareText(session(), rounds(true), 1, ORIGIN);

    expect(text.endsWith(ORIGIN)).toBe(true);
  });

  it('omits the link rather than shipping a broken one when no origin is set', () => {
    const text = buildShareText(session(), rounds(true), 1, '');

    expect(text.split('\n')).toHaveLength(2);
    expect(text).not.toContain('http');
  });
});
