import { hashDeviceId } from './device-id';

describe('hashDeviceId', () => {
  /**
   * Pinned to the published SHA-256 test vector, because the migration that
   * hashed the pre-existing rows computed the same digest in SQL. Any change
   * to encoding, case or algorithm here would orphan every migrated account.
   */
  it('is lowercase hex SHA-256 of the UTF-8 bytes', () => {
    expect(hashDeviceId('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('fits the column it is stored in', () => {
    expect(hashDeviceId('6f1c0a3e-8b6e-4a2f-9a9a-1c2d3e4f5a6b')).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});
