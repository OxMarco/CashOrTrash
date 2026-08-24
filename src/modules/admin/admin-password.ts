import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/**
 * Wrapped by hand rather than with `promisify`: the overload that takes cost
 * parameters is the one this needs, and `promisify`'s types collapse to the
 * three-argument form.
 */
const scryptAsync = (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });

/**
 * scrypt rather than bcrypt or argon2, for one reason: it is in Node's standard
 * library. The portal has exactly one credential, checked at most a few times a
 * day, so the marginal resistance of argon2id buys less here than not adding a
 * native dependency that has to compile on every image build.
 */
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const COST = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** `<salt-hex>:<key-hex>` — what `ADMIN_PASSWORD_HASH` holds. */
export async function hashAdminPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scryptAsync(password, salt, KEY_LENGTH, COST);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

/**
 * Constant-time against the stored key.
 *
 * A malformed or empty hash is a `false`, never a throw: the portal is disabled
 * by leaving `ADMIN_PASSWORD_HASH` unset, and that path must reject a login
 * rather than return a 500 that tells an attacker the difference between "no
 * portal here" and "wrong password".
 */
export async function verifyAdminPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(keyHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) {
    return false;
  }

  const actual = await scryptAsync(password, salt, KEY_LENGTH, COST);
  return timingSafeEqual(actual, expected);
}
