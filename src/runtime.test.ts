import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wasSignedInKey } from './identity.js';
import { createRandomSource, toBase64Url } from './random.js';
import { __resetRuntimes, getRuntime } from './runtime.js';

const cfg = (embedKey: string) => ({ widgetOrigin: 'https://w.x.ai', embedKey });

// Distinct bytes per call. A constant fill would make the post-rotate install id identical
// to the pre-rotate one, and every `notEqual` below would pass for the wrong reason —
// or fail while the code is correct.
let seed = 0;
const bytes = async (n: number) => new Uint8Array(n).fill(++seed % 251);

test('two runtimes for one embed key are the same object', () => {
  __resetRuntimes();
  assert.equal(getRuntime(cfg('k')), getRuntime(cfg('k')));
});

test('different embed keys get different runtimes', () => {
  __resetRuntimes();
  assert.notEqual(getRuntime(cfg('a')), getRuntime(cfg('b')));
});

test('concurrent installId() calls mint exactly one id', async () => {
  __resetRuntimes();
  let mints = 0;
  const counting = async (n: number) => {
    mints++;
    return new Uint8Array(n).fill(mints);
  };
  const rt = getRuntime(cfg('k'));
  const [a, b, c] = await Promise.all([
    rt.installId(counting),
    rt.installId(counting),
    rt.installId(counting),
  ]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(mints, 1, 'single-flight: two widgets must not each mint one');
});

test('logout rotates and clears identity, and notifies every subscriber', async () => {
  __resetRuntimes();
  const rt = getRuntime(cfg('k'));
  const before = await rt.installId(bytes);
  let reloads = 0;
  const off = rt.onReload(() => {
    reloads++;
  });
  await rt.logout();
  assert.notEqual(await rt.installId(bytes), before);
  assert.equal(reloads, 1);
  off();
});

test('logout with no subscribers rotates and does not throw', async () => {
  __resetRuntimes();
  const rt = getRuntime(cfg('k'));
  const before = await rt.installId(bytes);
  await rt.logout(); // the modal is closed, nothing is mounted
  assert.notEqual(await rt.installId(bytes), before);
});

test('a second getRuntime with a different identity reference swaps the provider in place', () => {
  __resetRuntimes();
  const rt1 = getRuntime({ ...cfg('k'), identity: { getToken: () => 't1' } });
  const identityBefore = rt1.identity;
  const rt2 = getRuntime({ ...cfg('k'), identity: { getToken: () => 't2' } });
  assert.equal(rt2, rt1, 'same runtime object — the swap happens in place');
  assert.notEqual(rt2.identity, identityBefore, 'a new identity reference means a new provider');
});

test('a second getRuntime with the same identity reference does not replace the provider', () => {
  __resetRuntimes();
  const identity = { getToken: () => 't1' };
  const rt1 = getRuntime({ ...cfg('k'), identity });
  const identityBefore = rt1.identity;
  const rt2 = getRuntime({ ...cfg('k'), identity });
  assert.equal(
    rt2.identity,
    identityBefore,
    'same reference: no rebuild, a reference check is the contract',
  );
});

test('swapping identity preserves subscribers and the install-id memo', async () => {
  __resetRuntimes();
  let mints = 0;
  const counting = async (n: number) => {
    mints++;
    return new Uint8Array(n).fill(mints);
  };
  const rt1 = getRuntime({ ...cfg('k'), identity: { getToken: () => 't1' } });
  const id1 = await rt1.installId(counting);
  let reloads = 0;
  rt1.onReload(() => {
    reloads++;
  });

  const rt2 = getRuntime({ ...cfg('k'), identity: { getToken: () => 't2' } });
  const id2 = await rt2.installId(counting);
  assert.equal(id2, id1, 'the install-id memo survives the swap, no re-mint');
  assert.equal(mints, 1);

  await rt2.logout();
  assert.equal(reloads, 1, 'the subscriber registered before the swap is still notified');
});

test('swapping identity does not clear the wasSignedIn flag — that is not a logout', () => {
  __resetRuntimes();
  const store = new Map<string, string>();
  const storage = {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      store.delete(k);
    },
  };
  store.set(wasSignedInKey('k'), '1');

  const rt1 = getRuntime({ ...cfg('k'), storage, identity: { getToken: () => 't1' } });
  assert.ok(rt1); // constructed against the seeded storage above
  getRuntime({ ...cfg('k'), storage, identity: { getToken: () => 't2' } });

  assert.equal(store.get(wasSignedInKey('k')), '1', 'the flag must survive an identity swap');
});

// The composition bug Task 7a's own tests could not see, because they only ever
// had one random source. Two widgets share this runtime (§2.4) but not their
// WebViews, and `random.ts` allows exactly one request in flight per source —
// so a source captured when the runtime was built is a source that belongs to
// somebody else, and is very often busy or gone.
test("a mint uses the calling widget's random source, not another widget's busy one", async () => {
  __resetRuntimes();
  // No real timers: an unanswered request must not arm a 2s timeout that keeps
  // the test runner alive (and then rejects into nothing).
  const noTimers = { setTimer: () => 0, clearTimer: () => {} };

  // Widget A: mid-handshake, its source already waiting on the session-key reply.
  const a = createRandomSource({ inject: () => {}, ...noTimers });
  const aSessionKey = a.bytes(16);
  aSessionKey.catch(() => {}); // never answered here
  let aCalls = 0;
  const aBytes = (n: number) => {
    aCalls++;
    return a.bytes(n);
  };

  // Widget B: its own WebView, its own source, free.
  const b = createRandomSource({
    inject: () => {},
    ...noTimers,
    globalCrypto: { getRandomValues: (arr: Uint8Array) => arr.fill(9) },
  });

  const rt = getRuntime(cfg('shared'));
  const [idB, idA] = await Promise.all([rt.installId(b.bytes), rt.installId(aBytes)]);

  assert.equal(idA, idB, 'both widgets must end up on the same anonymous user');
  assert.equal(idA, toBase64Url(new Uint8Array(16).fill(9)), 'minted from B, the free source');
  assert.equal(
    aCalls,
    0,
    "A's busy source must never be asked: single-flight covers the second caller",
  );
});
