import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRandomSource, RANDOM_REPLY_TAG, toBase64Url } from './random.js';

test('uses a polyfilled global crypto and never injects', async () => {
  let injected = 0;
  const src = createRandomSource({
    inject: () => {
      injected++;
    },
    globalCrypto: {
      getRandomValues: (a) => {
        a.fill(7);
        return a;
      },
    },
  });
  const b = await src.bytes(16);
  assert.equal(injected, 0);
  assert.equal(b.length, 16);
});

test('injects a script that ends in true; and resolves on the tagged reply', async () => {
  let script = '';
  const src = createRandomSource({
    inject: (s) => {
      script = s;
    },
  });
  const p = src.bytes(16);
  assert.ok(script.trimEnd().endsWith('true;'), 'injectJavaScript fails silently otherwise');
  assert.ok(script.includes('crypto.getRandomValues'));
  const taken = src.acceptReply(
    JSON.stringify({ tag: RANDOM_REPLY_TAG, bytes: Array(16).fill(3) }),
  );
  assert.equal(taken, true, 'the router must take this before the JSON-RPC parser');
  assert.equal((await p).length, 16);
});

test('acceptReply returns false for anything that is not its own reply', () => {
  const src = createRandomSource({ inject: () => {} });
  assert.equal(src.acceptReply('{"jsonrpc":"2.0","method":"mentiora/ready","params":{}}'), false);
});

test('rejects after the 2s bound when no reply arrives', async () => {
  let fire!: () => void; // not `| null`: TS2349, same as the peer tests
  const src = createRandomSource({
    inject: () => {},
    setTimer: (fn) => {
      fire = fn;
      return 1;
    },
    clearTimer: () => {},
  });
  const p = src.bytes(16);
  fire();
  await assert.rejects(p, /timed out/);
});

test('toBase64Url emits no +, / or = padding', () => {
  const s = toBase64Url(new Uint8Array([251, 255, 254, 0]));
  assert.ok(!/[+/=]/.test(s));
});

// --- Fix round 1 ---

test('a reply with the wrong number of bytes rejects instead of resolving short', async () => {
  const src = createRandomSource({ inject: () => {} });
  const p = src.bytes(16);
  const taken = src.acceptReply(JSON.stringify({ tag: RANDOM_REPLY_TAG, bytes: Array(3).fill(3) }));
  assert.equal(taken, true);
  await assert.rejects(p, /malformed/);
});

test('a reply with an out-of-range byte value rejects', async () => {
  const src = createRandomSource({ inject: () => {} });
  const p = src.bytes(4);
  const taken = src.acceptReply(JSON.stringify({ tag: RANDOM_REPLY_TAG, bytes: [1, 2, 300, -5] }));
  assert.equal(taken, true);
  await assert.rejects(p, /malformed/);
});

test('a second bytes() call while one is pending rejects, and the first still resolves', async () => {
  const src = createRandomSource({ inject: () => {} });
  const first = src.bytes(16);
  await assert.rejects(src.bytes(16), /already in flight/);
  const taken = src.acceptReply(
    JSON.stringify({ tag: RANDOM_REPLY_TAG, bytes: Array(16).fill(5) }),
  );
  assert.equal(taken, true);
  const b = await first;
  assert.equal(b.length, 16);
  assert.equal(b[0], 5);
});

test('a throwing globalCrypto rejects instead of throwing synchronously', async () => {
  const src = createRandomSource({
    inject: () => {},
    globalCrypto: {
      getRandomValues: () => {
        throw new Error('broken polyfill');
      },
    },
  });
  await assert.rejects(src.bytes(16), /broken polyfill/);
});
