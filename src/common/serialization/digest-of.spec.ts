import { digestOf } from './digest-of';

describe('digestOf', () => {
  it('is stable for the same payload', () => {
    const payload = [{ slug: 'watches', itemCount: 16 }];

    expect(digestOf(payload)).toBe(digestOf(payload));
    expect(digestOf(payload)).toBe(
      digestOf([{ slug: 'watches', itemCount: 16 }]),
    );
  });

  it('moves when any value changes', () => {
    const before = digestOf([{ slug: 'watches', itemCount: 16 }]);

    expect(digestOf([{ slug: 'watches', itemCount: 17 }])).not.toBe(before);
    expect(digestOf([{ slug: 'watch', itemCount: 16 }])).not.toBe(before);
  });

  it('moves when an entry is added or removed', () => {
    const one = digestOf([{ slug: 'watches' }]);

    expect(digestOf([{ slug: 'watches' }, { slug: 'cars' }])).not.toBe(one);
    expect(digestOf([])).not.toBe(one);
  });

  /**
   * The manifest is only useful if a version means "the payload changed", so
   * order has to count: a picker that reshuffled is one a client should
   * refetch, even though the same categories are in it.
   */
  it('moves when the order changes', () => {
    expect(digestOf(['a', 'b'])).not.toBe(digestOf(['b', 'a']));
  });

  it('is short enough to store and compare cheaply', () => {
    expect(digestOf({})).toMatch(/^[0-9a-f]{16}$/);
  });
});
