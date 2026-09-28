import assert from 'node:assert/strict';
import { fromBase64Url, toBase64Url } from './base64url.js';

test('toBase64Url emits no +, / or = padding', () => {
  const s = toBase64Url(new Uint8Array([251, 255, 254, 0]));
  assert.ok(!/[+/=]/.test(s));
});

test('matches Buffer and round-trips every tail length', () => {
  for (let n = 0; n <= 5; n++) {
    const bytes = new Uint8Array(n).map((_, i) => 250 - i * 17);
    const encoded = toBase64Url(bytes);
    assert.equal(encoded, Buffer.from(bytes).toString('base64url'));
    assert.deepEqual(fromBase64Url(encoded), bytes);
  }
});

test('fromBase64Url rejects a character outside the alphabet', () => {
  assert.throws(() => fromBase64Url('ab+c'), /invalid base64url character/);
});
