/**
 * Run: `bun run check:example-mint` (CI runs it too). It lives here rather than beside
 * `fake-backend.ts` because it is a Node script; inside `example/src` it would be typed as
 * app code, where `node:crypto` and `Buffer` do not exist.
 *
 * `fake-backend.ts` hand-rolls UTF-8 encoding and base64url because Hermes guarantees
 * neither `TextEncoder` nor `btoa`. Both are the kind of code that fails silently on one
 * input class — a 3-byte character, a payload length whose base64 needs padding — and
 * produces a token the backend rejects with no useful message. This asserts the output is
 * byte-identical to what Node's own HMAC and base64 produce.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mintIdentityToken } from '../example/src/fake-backend';

const b64 = (input: Buffer): string =>
  input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Copied from mentiora-cx `scripts/widget-dev/src/run.ts`, which mints the real thing. */
const reference = (claims: unknown, secret: string): string => {
  const head = b64(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64(Buffer.from(JSON.stringify(claims)));
  return `${head}.${body}.${b64(createHmac('sha256', secret).update(`${head}.${body}`).digest())}`;
};

const secret = 'not-a-real-secret-only-for-this-check';
const now = Math.floor(Date.now() / 1000);

// One ASCII name, one that needs 2-, 3- and 4-byte UTF-8, and one with no claims at all.
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
