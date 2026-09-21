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
