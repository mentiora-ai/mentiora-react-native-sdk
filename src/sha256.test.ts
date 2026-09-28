import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex } from './sha256.js';

const ascii = (s: string): Uint8Array => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

// FIPS 180-2 appendix B vectors.
test('the empty message', () => {
  assert.equal(
    sha256Hex(new Uint8Array(0)),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('abc', () => {
  assert.equal(
    sha256Hex(ascii('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('the 448-bit message, which forces a second padding block', () => {
  assert.equal(
    sha256Hex(ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
});

test('one million a', () => {
  assert.equal(
    sha256Hex(new Uint8Array(1_000_000).fill(0x61)),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  );
});

test('every length from 0 to 130 bytes matches node:crypto', () => {
  for (let n = 0; n <= 130; n++) {
    const input = new Uint8Array(n).map((_, i) => (i * 31 + n) & 0xff);
    assert.equal(sha256Hex(input), createHash('sha256').update(input).digest('hex'), `n=${n}`);
  }
});
