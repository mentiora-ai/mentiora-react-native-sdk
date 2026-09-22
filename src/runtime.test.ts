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

// Two widgets share this runtime but not their WebViews, and `random.ts` allows
// exactly one request in flight per source. A source captured when the runtime was
// built therefore belongs to somebody else, and is often busy or gone. A single-
// source test cannot see that.
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

// `Promise.all` evaluates its array elements synchronously, so above the first call
// wins by call order, not by caller identity: a `buildEntry` that captured the first
// `randomBytes` it was ever handed would pass there too. Two separate sequential
// mints, with `logout()` between them to clear the memo, pin that the second source
// is the one invoked and the one whose bytes come back.
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

// Nothing else covers the identity half of `logout()`: the presenter's logout tests
// check the install id only, and "logout rotates and clears identity" above asserts
// the rotation and the subscriber. Dropping `await runtime.identity.clear()` leaves
// the previous user's `wasSignedIn` flag set on a now-anonymous install, which
// `initial()` turns into a hard handshake failure on every later boot.
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

// Dropping the install-id memo and then awaiting the rotation leaves a window in
// between: a mint landing there misses the memo, reads storage before `removeItem`
// has landed, and returns and re-memoises the pre-rotation id — the previous user's,
// handed to the next one.
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

// Assigning `rotation` the rotation promise itself, and clearing it only on the line
// after the await, leaves it pointing at a rejected promise forever once `removeItem`
// rejects: every later `installId()` parks behind it and re-throws a failure that is
// long over. Through the `initialize` handler's catch that is an error screen the
// user cannot get past for the life of the process.
//
// Two tests, split by when the mint arrives, because two independent lines each stop
// the permanent case on their own and a single test would pass under either mutation.
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

// Fails on `rotation = rotating` in place of `rotation = rotating.catch(() =>
// undefined)`, where a mint parked before the `finally` ran inherits the rotation's
// failure.
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

// The other half: with `rotation` left a rejected promise, every later mint re-throws
// a failure that is over.
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

// `logout()` waits for a mint that is already running. Dropping `inFlight` and
// rotating without waiting lets a `loadOrCreateInstallId` blocked in `storage.setItem`
// commit after `removeItem`: the pre-logout id survives its own rotation, or two
// surfaces end up on two different anonymous users.
test('a pre-logout install-id write cannot land after the rotation deleted it', async () => {
  __resetRuntimes();
  const store = new Map<string, string>();
  const order: string[] = [];
  let releaseWrite!: () => void;
  const written = new Promise<void>((r) => {
    releaseWrite = r;
  });
  const storage = {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      await written; // the mint is blocked here when logout starts
      if (k.includes('installId')) order.push('setItem');
      store.set(k, v);
    },
    // The identity provider removes its own key here too; only the install id
    // is what this test is about.
    removeItem: async (k: string) => {
      if (k.includes('installId')) order.push('removeItem');
      store.delete(k);
    },
  };

  const rt = getRuntime({ ...cfg('b3'), storage });
  const minting = rt.installId(bytes); // parked inside setItem

  const loggingOut = rt.logout();
  releaseWrite();
  await minting;
  await loggingOut;

  assert.deepEqual(order, ['setItem', 'removeItem'], 'the delete must come last');
  assert.equal(store.size, 0, 'nothing may survive the rotation');

  // And the next widget mints a genuinely new id rather than reading the
  // previous user's write back out of storage.
  const after = await rt.installId(bytes);
  assert.notEqual(after, await minting);
});

test('a rejecting pre-logout mint still lets the rotation through (settle, not succeed)', async () => {
  __resetRuntimes();
  const store = new Map<string, string>();
  let failWrite!: (e: Error) => void;
  const blocked = new Promise<void>((_res, rej) => {
    failWrite = rej;
  });
  blocked.catch(() => undefined);
  let firstWrite = true;
  const storage = {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      if (firstWrite) {
        firstWrite = false;
        await blocked; // the pre-logout mint, which never commits
      }
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      store.delete(k);
    },
  };
  const rt = getRuntime({ ...cfg('b3-fail'), storage });
  const minting = rt.installId(bytes);
  minting.catch(() => undefined);

  const loggingOut = rt.logout();
  failWrite(new Error('disk full'));
  await loggingOut; // must not hang, and must not inherit the failure
  assert.ok(await rt.installId(bytes));
});

// Reading `runtime.identity` only at the end of `logout()` leaves a provider swapped
// in by `getRuntime()` while the rotation is in flight outside the logout — free to
// write its token and the `wasSignedIn` marker back afterwards.
test('a provider swapped in mid-logout is inside the logout, and so is the old one', async () => {
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
    removeItem: async (k: string) => {
      await landed;
      store.delete(k);
    },
  };

  const rt = getRuntime({ ...cfg('swap'), storage, identity: { getToken: () => 't1' } });
  const first = rt.identity;
  let firstCleared = 0;
  let secondCleared = 0;
  rt.identity = { ...first, clear: async () => void firstCleared++ };
  const wrappedFirst = rt.identity;

  const loggingOut = rt.logout(); // captures wrappedFirst, then parks in removeItem
  // The customer reconfigures with a different identity reference mid-logout.
  getRuntime({ ...cfg('swap'), storage, identity: { getToken: () => 't2' } });
  const second = rt.identity;
  assert.notEqual(second, wrappedFirst, 'getRuntime swapped the provider in place');
  rt.identity = { ...second, clear: async () => void secondCleared++ };

  land();
  await loggingOut;

  assert.equal(firstCleared, 1, 'the provider that was live when logout began');
  assert.equal(secondCleared, 1, 'and the one swapped in while it ran');
});

// The rotation has already happened by the time `clear()` runs, so letting a
// rejecting `clear()` skip the reload subscribers leaves the mounted WebView running
// with its pre-logout token while storage holds no install id at all.
test('a rejecting clear() still reloads every subscriber, and still rejects', async () => {
  __resetRuntimes();
  const store = new Map<string, string>();
  const storage = {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      if (k.includes('wasSignedIn')) throw new Error('flag removal failed');
      store.delete(k);
    },
  };
  const rt = getRuntime({ ...cfg('m3'), storage });
  let reloads = 0;
  rt.onReload(() => {
    reloads++;
  });

  await assert.rejects(rt.logout(), /flag removal failed/);
  assert.equal(reloads, 1, 'the widget must not keep running on the pre-logout token');
});

// Nulling `inFlight` unconditionally in the memo's `.finally` lets a prior mint
// settling after `logout()` erase the memo a post-logout caller already installed.
// The next caller finds no memo, reads storage past the rotation and mints a second
// id, putting two surfaces on two different anonymous users.
test('a prior mint settling after logout does not erase the post-logout memo', async () => {
  __resetRuntimes();
  const store = new Map<string, string>();
  let releaseWrite!: () => void;
  let releaseRotate!: () => void;
  const written = new Promise<void>((r) => {
    releaseWrite = r;
  });
  const rotated = new Promise<void>((r) => {
    releaseRotate = r;
  });
  let firstWrite = true;
  const storage = {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      if (firstWrite) {
        firstWrite = false;
        await written; // the pre-logout mint parks here
      }
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      if (k.includes('installId')) await rotated; // the rotation parks here
      store.delete(k);
    },
  };

  const rt = getRuntime({ ...cfg('f2'), storage });
  const prior = rt.installId(bytes); // parked inside setItem
  const loggingOut = rt.logout(); // drops the memo, parks new mints on the rotation
  const postLogout = rt.installId(bytes); // the NEW memo, parked on the rotation

  releaseWrite();
  await prior; // its `.finally` runs here, with the rotation still in flight

  assert.equal(
    rt.installId(bytes),
    postLogout,
    'the settling prior mint must not drop a newer memo',
  );

  releaseRotate();
  await loggingOut;
  assert.equal(await rt.installId(bytes), await postLogout, 'one post-logout id, not two');
});

// The logout generation is shared, not a closure local of each provider. As a local,
// a provider `getRuntime` discards on an identity swap — which an inline
// `identity={{ getToken }}` literal triggers on every render, by this module's
// reference-equality contract — never sees the logout: its parked mint resumes and
// writes the `wasSignedIn` marker onto a logged-out install, after which `initial()`
// throws `IdentityUnavailable` on every boot and the user is stuck on a
// `handshake_timeout` screen permanently.
test('a provider discarded by an identity swap is still inside a later logout', async () => {
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
  let release!: (token: string) => void;
  const rt = getRuntime({
    ...cfg('f3'),
    storage,
    identity: {
      getToken: () =>
        new Promise<string>((res) => {
          release = res;
        }),
    },
  });
  const booting = rt.identity.initial(); // parked inside getToken on the FIRST provider

  // A re-render passing a fresh object literal: `getRuntime` swaps the provider
  // in place and the one above becomes unreachable — with its mint still live.
  getRuntime({ ...cfg('f3'), storage, identity: { getToken: () => 'second' } });

  await rt.logout();
  release('first'); // the discarded provider's mint resumes, post-logout
  await booting;

  assert.equal(
    store.get(wasSignedInKey('f3')),
    undefined,
    'a discarded provider must not mark a logged-out install as signed in',
  );
});

// The rotation half of the case above: an `installId` `removeItem` rejection
// propagating straight out leaves the identity cache, the `wasSignedIn` marker and
// every mounted WebView's session alive through the logout.
test('a rejecting rotation still clears identity, still reloads, and still rejects', async () => {
  __resetRuntimes();
  const store = new Map<string, string>();
  const storage = {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      if (k.includes('installId')) throw new Error('install id removal failed');
      store.delete(k);
    },
  };
  const rt = getRuntime({ ...cfg('f6'), storage, identity: { getToken: () => 'tok' } });
  await rt.identity.initial(); // sets the wasSignedIn marker
  assert.equal(store.get(wasSignedInKey('f6')), '1', 'precondition');

  let reloads = 0;
  rt.onReload(() => {
    reloads++;
  });

  await assert.rejects(rt.logout(), /install id removal failed/);
  assert.equal(reloads, 1, 'the widget must not keep running on the pre-logout session');
  assert.equal(store.get(wasSignedInKey('f6')), undefined, 'identity must be cleared anyway');
});
