#!/usr/bin/env node
/**
 * Prints an ADMIN_PASSWORD_HASH for the portal password.
 *
 * Reads the password from stdin rather than argv so it never reaches the shell
 * history or the process table:
 *
 *   printf '%s' 'the password' | npm run admin:hash
 *
 * Mirrors `hashAdminPassword` in src/modules/admin/admin-password.ts. Kept as a
 * standalone script rather than importing that module so it runs against a
 * checkout with nothing built.
 */
import { randomBytes, scrypt } from 'node:crypto';

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const COST = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const password = await new Promise((resolve, reject) => {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => resolve(input.replace(/\r?\n$/, '')));
  process.stdin.on('error', reject);
});

if (!password) {
  console.error(
    "No password on stdin. Usage: printf '%s' 'the password' | npm run admin:hash",
  );
  process.exit(1);
}
if (password.length < 12) {
  console.error(
    `That password is ${password.length} characters. The portal is the only ` +
      'thing standing between the open internet and the catalogue — use at least 12.',
  );
  process.exit(1);
}

const salt = randomBytes(SALT_LENGTH);
const key = await new Promise((resolve, reject) => {
  scrypt(password, salt, KEY_LENGTH, COST, (error, derived) =>
    error ? reject(error) : resolve(derived),
  );
});

console.log(`ADMIN_PASSWORD_HASH=${salt.toString('hex')}:${key.toString('hex')}`);
