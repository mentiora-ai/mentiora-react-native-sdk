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
test('single-flight covers the second caller, and a busy source is never touched', async () => {
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

// `Promise.all` evaluates its array elements synchronously, so in the test above the
// first call wins BY CALL ORDER, not by caller identity — it cannot tell "forward this
// call's source" from "remember whichever source arrived first". A `buildEntry` that
// captured the first `randomBytes` function it was ever handed and reused it forever
// would still pass every assertion above. This drives two SEPARATE, sequential mints —
// with `logout()` between them to clear the memo — and checks the SECOND source is the
// one actually invoked and the one whose bytes come back, which a capture-once mutant
// cannot satisfy.
test("a later mint, after logout, invokes that call's own source rather than an earlier one", async () => {
  __resetRuntimes();
  const noTimers = { setTimer: () => 0, clearTimer: () => {} };

  const x = createRandomSource({
    inject: () => {},
    ...noTimers,
    globalCrypto: { getRandomValues: (arr: Uint8Array) => arr.fill(1) },
  });
  let xCalls = 0;
  const xBytes = (n: number) => {
    xCalls++;
    return x.bytes(n);
  };

  const rt = getRuntime(cfg('sequential'));
  const idX = await rt.installId(xBytes);
  assert.equal(xCalls, 1);
  assert.equal(idX, toBase64Url(new Uint8Array(16).fill(1)));

  await rt.logout(); // clears the install-id memo; a fresh mint is due next call

  const y = createRandomSource({
    inject: () => {},
    ...noTimers,
    globalCrypto: { getRandomValues: (arr: Uint8Array) => arr.fill(2) },
  });
  let yCalls = 0;
  const yBytes = (n: number) => {
    yCalls++;
    return y.bytes(n);
  };

  const idY = await rt.installId(yBytes);
  assert.equal(yCalls, 1, "Y's source must actually be invoked, not skipped for a memoised one");
  assert.equal(
    idY,
    toBase64Url(new Uint8Array(16).fill(2)),
    "Y's bytes must come back — a capture-once-per-entry mutant would return X's instead",
  );
});

// Branch review, M5. Deleting `await runtime.identity.clear()` from `logout()`
// left the whole suite green: the presenter's logout tests check the install
// id only, and "logout rotates and clears identity" above asserts the rotation
// and the subscriber, never the identity half. A refactor that dropped that
// line would ship green, leaving the previous user's `wasSignedIn` flag set on
// a now-anonymous install — which `identity.ts`'s `initial()` turns into a
// hard handshake failure on the next boot (§2.3), i.e. a device that can no
// longer open the widget at all.
test('logout clears identity too, not only the install id', async () => {
  __resetRuntimes();
  const store = new Map<string, string>();
  const removed: string[] = [];
  const storage = {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      removed.push(k);
      store.delete(k);
    },
  };
  store.set(wasSignedInKey('k'), '1'); // this install has held a token before

  const rt = getRuntime({ ...cfg('k'), storage, identity: { getToken: () => 'tok' } });
  await rt.logout();

  assert.ok(
    removed.includes(wasSignedInKey('k')),
    'the flag must go with the user; left set on a rotated, anonymous install it deadlocks the next boot',
  );
  assert.equal(store.get(wasSignedInKey('k')), undefined);
});

// Branch review, m5. `logout()` dropped the install-id memo and then awaited
// the rotation, leaving a window in between: a mint landing there missed the
// memo, read storage before `removeItem` had landed, and both returned AND
// re-memoised the pre-rotation id — the previous user's, handed to the next
// one, which is the exact thing dropping the memo was there to prevent. The
// comment claimed the opposite ("reads storage fresh, past the rotation").
test('an installId() landing mid-logout waits for the rotation instead of reading past it', async () => {
  __resetRuntimes();
  const store = new Map<string, string>();
  let land!: () => void;
  const landed = new Promise<void>((r) => {
    land = r;
  });
  const storage = {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v);
    },
    // A rotation that takes a moment — AsyncStorage is a real round trip to
    // native, so this window is not hypothetical.
    removeItem: async (k: string) => {
      await landed;
      store.delete(k);
    },
  };

  const rt = getRuntime({ ...cfg('race'), storage });
  const before = await rt.installId(bytes);

  const loggingOut = rt.logout(); // not awaited: we want the window it opens
  const racing = rt.installId(bytes); // lands inside it
  land();
  await loggingOut;

  assert.notEqual(
    await racing,
    before,
    "the previous user's install id must not survive the logout that rotated it",
  );
});

// Re-review, N1 — a regression the m5 fix introduced. `rotation` used to be
// assigned the rotation promise ITSELF and cleared only on the line AFTER the
// await, so a `removeItem` that rejected left it pointing at a rejected
// promise forever: every later `installId()` parked behind it and re-threw a
// failure that was long over. Through the `initialize` handler's catch that is
// an error screen the user cannot get past, for the life of the process.
//
// Two tests, because the repair is two independent lines and each one alone is
// enough to stop the permanent case — so a single test passes under either
// mutation and proves nothing. They split by WHEN the mint arrives.
const failingRotation = () => {
  const store = new Map<string, string>();
  let failRemove = true;
  const storage = {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      if (failRemove) throw new Error('disk full');
      store.delete(k);
    },
  };
  return {
    storage,
    heal: () => {
      failRemove = false;
    },
  };
};

// Catches `rotation = rotating` in place of `rotation = rotating.catch(() =>
// undefined)`: a mint that parked before the `finally` ran inherits the
// rotation's failure.
test('a mint landing DURING a failing logout does not inherit the failure', async () => {
  __resetRuntimes();
  const { storage } = failingRotation();
  const rt = getRuntime({ ...cfg('poison-concurrent'), storage });
  const before = await rt.installId(bytes);

  const loggingOut = rt.logout(); // not awaited: we want the window it opens
  const racing = rt.installId(bytes); // parks on `rotation`, whatever it is

  await assert.rejects(loggingOut, /disk full/, 'the failure must still reach the caller');
  assert.equal(
    await racing,
    before,
    'the rotation never landed, so the id is unchanged — the mint is not broken',
  );
});

// The direct N1 repro: the pre-fix form (`rotation = rotating`, cleared on the
// line after the await) left `rotation` a rejected promise forever, so every
// LATER mint re-threw a failure that was over. Fails under that form.
test('a removeItem failure during logout does not poison every later install-id mint', async () => {
  __resetRuntimes();
  const { storage, heal } = failingRotation();
  const rt = getRuntime({ ...cfg('poison-later'), storage });
  const before = await rt.installId(bytes);

  await assert.rejects(rt.logout(), /disk full/);

  heal(); // the disk is fine again
  assert.equal(await rt.installId(bytes), before);
  // The second and third calls too: a one-shot rejected promise would satisfy
  // a single retry by accident.
  assert.equal(await rt.installId(bytes), before);
  assert.equal(await rt.installId(bytes), before);
});
