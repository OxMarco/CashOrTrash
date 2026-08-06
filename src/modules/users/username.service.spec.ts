import {
  UsernameService,
  USERNAME_INVALID,
  USERNAME_NOT_ALLOWED,
} from './username.service';

describe('UsernameService', () => {
  const usernames = new UsernameService();

  describe('normalising', () => {
    it('folds case and trims, because storage is case-insensitive', () => {
      expect(usernames.normalise('  MixedCase  ')).toBe('mixedcase');
    });

    it('reports the normalised form even when it rejects the name', () => {
      expect(usernames.check('  AB  ')).toMatchObject({
        ok: false,
        normalised: 'ab',
        reason: 'too_short',
      });
    });
  });

  describe('shape', () => {
    it.each([
      ['sam', 'a short handle at the minimum'],
      ['bargain.beth', 'dots'],
      ['sam_the_guesser', 'underscores'],
      ['thrift2king', 'digits after the first character'],
    ])('accepts %s (%s)', (candidate) => {
      expect(usernames.check(candidate).ok).toBe(true);
    });

    it.each([
      ['ab', 'too_short'],
      ['a'.repeat(17), 'too_long'],
      ['9lives', 'invalid_characters'],
      ['sam the guesser', 'invalid_characters'],
      ['sam-the-guesser', 'invalid_characters'],
      ['admin', 'reserved'],
      ['cashortrashteam', 'reserved'],
    ])('rejects %s as %s', (candidate, reason) => {
      expect(usernames.check(candidate)).toMatchObject({ ok: false, reason });
    });
  });

  describe('vulgarity', () => {
    it.each([
      ['plain spelling', 'fuckface'],
      ['separated by dots', 'f.u.c.k'],
      ['separated by underscores', 'f_u_c_k'],
      ['leetspeak', 'sh1thead'],
      ['character substitution', 'fvckyou'],
      ['repeated letters', 'fuuuck'],
      ['a slur the dataset does not carry', 'paki_lad'],
    ])('rejects %s (%s)', (_case, candidate) => {
      expect(usernames.check(candidate)).toMatchObject({
        ok: false,
        reason: 'profane',
      });
    });

    /**
     * The reason a package replaced the hand-written substring list: every one
     * of these contains a blocked word as a substring, and none of them is one.
     */
    it.each(['classiccars', 'bassmaster', 'assistant', 'scunthorpe'])(
      'does not reject %s',
      (candidate) => {
        expect(usernames.check(candidate).ok).toBe(true);
      },
    );
  });

  describe('problem codes', () => {
    it('gives a format problem its own code, so the client can point at the field', () => {
      expect(usernames.problemCode('too_short')).toBe(USERNAME_INVALID);
      expect(usernames.problemCode('invalid_characters')).toBe(
        USERNAME_INVALID,
      );
    });

    // Telling someone which filter they tripped is a hint about how to get the
    // next variation past it.
    it('answers reserved and profane identically', () => {
      expect(usernames.problemCode('reserved')).toBe(USERNAME_NOT_ALLOWED);
      expect(usernames.problemCode('profane')).toBe(USERNAME_NOT_ALLOWED);
      expect(usernames.describe('reserved')).toBe(
        usernames.describe('profane'),
      );
    });
  });
});
