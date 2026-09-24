import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRandomSource, RANDOM_REPLY_TAG, toBase64Url } from './random.js';

// Read back out of the injected script, so dropping the nonce entirely fails here.
const nonceOf = (script: string): string => {
  const m = /,k="([^"]+)"/.exec(script);
  assert.ok(m, 'the injected script must carry a per-request nonce');
  return m[1] as string;
};

const reply = (script: string, body: Record<string, unknown>): string =>
  JSON.stringify({ tag: RANDOM_REPLY_TAG, nonce: nonceOf(script), ...body });

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
  const taken = src.acceptReply(reply(script, { bytes: Array(16).fill(3) }));
  assert.equal(taken, true, 'the router must take this before the JSON-RPC parser');
  assert.equal((await p).length, 16);
});

test('acceptReply returns false for anything that is not its own reply', () => {
  const src = createRandomSource({ inject: () => {} });
  assert.equal(src.acceptReply('{"jsonrpc":"2.0","method":"mentiora/ready","params":{}}'), false);
});

test('rejects after the 2s bound when no reply arrives', async () => {
  let fire!: () => void; // not `| null`: TS2349
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

test('a reply with the wrong number of bytes rejects instead of resolving short', async () => {
  let script = '';
  const src = createRandomSource({
    inject: (s) => {
      script = s;
    },
  });
  const p = src.bytes(16);
  const taken = src.acceptReply(reply(script, { bytes: Array(3).fill(3) }));
  assert.equal(taken, true);
  await assert.rejects(p, /malformed/);
});

test('a reply with an out-of-range byte value rejects', async () => {
  let script = '';
  const src = createRandomSource({
    inject: (s) => {
      script = s;
    },
  });
  const p = src.bytes(4);
  const taken = src.acceptReply(reply(script, { bytes: [1, 2, 300, -5] }));
  assert.equal(taken, true);
  await assert.rejects(p, /malformed/);
});

test('a second bytes() call while one is pending rejects, and the first still resolves', async () => {
  let script = '';
  const src = createRandomSource({
    inject: (s) => {
      script = s;
    },
  });
  const first = src.bytes(16);
  await assert.rejects(src.bytes(16), /already in flight/);
  const taken = src.acceptReply(reply(script, { bytes: Array(16).fill(5) }));
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

// A reset must invalidate parked random-bytes resolvers too: one left by a replaced
// document holds the single in-flight slot for 2s and rejects the new `initialize`.
test('reset frees the single-in-flight slot for the replacement page', async () => {
  let cleared = 0;
  let script = '';
  const src = createRandomSource({
    inject: (s) => {
      script = s;
    },
    setTimer: () => 'timer',
    clearTimer: () => {
      cleared++;
    },
  });
  const parked = src.bytes(16); // the dead document's request
  src.reset();
  await assert.rejects(parked, /superseded/);
  assert.equal(cleared, 1, "the dead request's 2s timer must not outlive it");

  // The next page may ask, rather than hitting "already in flight".
  const fresh = src.bytes(16);
  assert.equal(src.acceptReply(reply(script, { bytes: Array(16).fill(3) })), true);
  assert.equal((await fresh)[0], 3);
});

test('reset with nothing parked is a no-op, not a spurious rejection', async () => {
  const src = createRandomSource({
    inject: () => {},
    globalCrypto: {
      getRandomValues: (a) => {
        a.fill(1);
        return a;
      },
    },
  });
  src.reset();
  assert.equal((await src.bytes(16))[0], 1);
});

// Authenticated by nonce, not by the module-constant `obj.tag`: anything reaching
// `ReactNativeWebView.postMessage` could otherwise choose the session key and install id.
test('a tagged reply with a foreign nonce neither resolves nor consumes the request', async () => {
  let script = '';
  let cleared = 0;
  const src = createRandomSource({
    inject: (s) => {
      script = s;
    },
    setTimer: () => 'timer',
    clearTimer: () => {
      cleared++;
    },
  });
  const p = src.bytes(16);

  const forged = src.acceptReply(
    JSON.stringify({ tag: RANDOM_REPLY_TAG, nonce: 'guessed', bytes: Array(16).fill(0) }),
  );
  assert.equal(forged, false, 'not ours: it must fall through to the JSON-RPC parser');
  assert.equal(cleared, 0, 'the pending request must not have been consumed');

  assert.equal(
    src.acceptReply(JSON.stringify({ tag: RANDOM_REPLY_TAG, bytes: Array(16).fill(0) })),
    false,
  );

  assert.equal(src.acceptReply(reply(script, { bytes: Array(16).fill(9) })), true);
  const b = await p;
  assert.equal(b[0], 9);
});

test('a forged error reply cannot reject the pending request either', async () => {
  let script = '';
  const src = createRandomSource({ inject: (s) => (script = s) });
  const p = src.bytes(16);
  assert.equal(
    src.acceptReply(JSON.stringify({ tag: RANDOM_REPLY_TAG, nonce: 'x', error: 'no crypto' })),
    false,
  );
  assert.equal(src.acceptReply(reply(script, { bytes: Array(16).fill(1) })), true);
  assert.equal((await p)[0], 1);
});

test('each request gets a different nonce', () => {
  const scripts: string[] = [];
  const src = createRandomSource({
    inject: (s) => {
      scripts.push(s);
    },
    setTimer: () => 'timer',
    clearTimer: () => {},
  });
  const swallow = () => {};
  src.bytes(16).catch(swallow);
  src.reset();
  src.bytes(16).catch(swallow);
  assert.notEqual(nonceOf(scripts[0] as string), nonceOf(scripts[1] as string));
});

test("a superseded document's reply cannot answer the replacement page's request", async () => {
  const scripts: string[] = [];
  const src = createRandomSource({
    inject: (s) => {
      scripts.push(s);
    },
    setTimer: () => 'timer',
    clearTimer: () => {},
  });
  const dead = src.bytes(16);
  await assert.rejects(
    (async () => {
      src.reset();
      await dead;
    })(),
    /superseded/,
  );
  const fresh = src.bytes(16);
  assert.equal(
    src.acceptReply(reply(scripts[0] as string, { bytes: Array(16).fill(4) })),
    false,
    "the dead document's bytes must not become the new page's session key",
  );
  assert.equal(src.acceptReply(reply(scripts[1] as string, { bytes: Array(16).fill(6) })), true);
  assert.equal((await fresh)[0], 6);
});
