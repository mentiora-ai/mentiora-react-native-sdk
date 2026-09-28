// Checks `fake-backend.ts`'s hand-rolled UTF-8/base64url against Node's. Lives outside
// `example/src` because app code is typed without `node:crypto` and `Buffer`.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mintIdentityToken } from '../example/src/fake-backend';

const b64 = (input: Buffer): string =>
  input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Reference HS256 JWT signer built on `node:crypto`. */
const reference = (claims: unknown, secret: string): string => {
  const head = b64(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64(Buffer.from(JSON.stringify(claims)));
  return `${head}.${body}.${b64(createHmac('sha256', secret).update(`${head}.${body}`).digest())}`;
};

const secret = 'not-a-real-secret-only-for-this-check';
const now = Math.floor(Date.now() / 1000);

const cases: ReadonlyArray<readonly [string, string]> = [
  ['alice', 'Alice'],
  ['bob', 'Böß 東京 \u{1F600}'],
  ['carol', ''],
];
for (const [sub, name] of cases) {
  const claims: Record<string, string> = name === '' ? {} : { name };
  assert.equal(
    mintIdentityToken(secret, { sub, claims }),
    reference({ ...claims, sub, aud: 'mentiora', iat: now, exp: now + 300 }, secret),
    `token mismatch for sub=${sub}`,
  );
}

// Every base64 residue class, so a padding bug cannot hide behind one payload length.
for (let length = 1; length <= 8; length += 1) {
  const sub = 'a'.repeat(length);
  const payload = mintIdentityToken(secret, { sub }).split('.')[1] ?? '';
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url').toString()).sub, sub);
}

// Claims the token defines itself must not be overridable by a caller.
const forged = mintIdentityToken(secret, {
  sub: 'dave',
  claims: { sub: 'admin', aud: 'elsewhere', name: 'Dave' } as Record<string, string>,
});
const decoded = JSON.parse(Buffer.from(forged.split('.')[1] ?? '', 'base64url').toString());
assert.equal(decoded.sub, 'dave');
assert.equal(decoded.aud, 'mentiora');

console.log('fake-backend: token matches the reference signer on all cases');
