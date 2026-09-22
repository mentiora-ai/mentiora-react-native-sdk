import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createIdentityProvider,
  decodeExp,
  IdentityUnavailable,
  wasSignedInKey,
} from './identity.js';
import type { MentioraStorage } from './storage.js';

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (exp: number, iat = exp - 3600) =>
  `${b64url({ alg: 'HS256' })}.${b64url({ exp, iat })}.sig`;

// Every provider needs storage for the wasSignedIn flag. It never holds the token.
const memory = () => {
  const m = new Map<string, string>();
  const storage: MentioraStorage = {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => {
      m.set(k, v);
    },
    removeItem: async (k) => {
      m.delete(k);
    },
  };
  return { m, storage };
};
const make = (deps: Partial<Parameters<typeof createIdentityProvider>[0]> = {}) =>
  createIdentityProvider({ embedKey: 'k', storage: memory().storage, ...deps });

test('decodeExp reads exp without verifying, and survives junk', () => {
  assert.equal(decodeExp(jwt(1800000000)), 1800000000);
  assert.equal(decodeExp('not.a.jwt'), null);
  assert.equal(decodeExp(''), null);
});

test('no identity configured means anonymous, not an error', async () => {
  const p = make();
  assert.equal(await p.initial(), undefined);
});

test('getToken is called at boot and again on refresh', async () => {
  let calls = 0;
  const p = make({
    identity: {
      getToken: () => {
        calls++;
        return jwt(2000000000);
      },
    },
  });
  await p.initial();
  await p.refresh();
  assert.equal(calls, 2);
});

test('the fetcher reuses a cached token but not one inside the 5-minute floor', async () => {
  const now = 1_000_000_000_000;
  let hits = 0;
  const p = make({
    identity: { endpoint: 'https://api.example.com/token' },
    now: () => now,
    fetchImpl: (async () => {
      hits++;
      return {
        ok: true,
        json: async () => ({ token: jwt(now / 1000 + 600) }),
      } as unknown as Response;
    }) as typeof fetch,
  });
  await p.initial();
  await p.refresh(); // 10 min left, outside the floor: reuse
  assert.equal(hits, 1);
});

test('a token inside the floor is refetched', async () => {
  const now = 1_000_000_000_000;
  let hits = 0;
  const p = make({
    identity: { endpoint: 'https://api.example.com/token' },
    now: () => now,
    fetchImpl: (async () => {
      hits++;
      return {
        ok: true,
        json: async () => ({ token: jwt(now / 1000 + 120) }),
      } as unknown as Response;
    }) as typeof fetch,
  });
  await p.initial();
  await p.refresh(); // 2 min left, inside the floor: refetch
  assert.equal(hits, 2);
});

test('accepts a bare string, { token } and { identityToken }', async () => {
  for (const shape of ['"raw"', '{"token":"t"}', '{"identityToken":"t"}']) {
    const p = make({
      identity: { endpoint: 'https://x/y' },
      fetchImpl: (async () =>
        ({ ok: true, json: async () => JSON.parse(shape) }) as unknown as Response) as typeof fetch,
    });
    assert.ok(await p.initial());
  }
});

test('retries then throws IdentityUnavailable inside the 8s budget', async () => {
  let hits = 0;
  const p = make({
    identity: { endpoint: 'https://x/y' },
    fetchImpl: (async () => {
      hits++;
      throw new Error('network');
    }) as typeof fetch,
    sleep: async () => {},
    random: () => 1,
  });
  await assert.rejects(p.refresh(), IdentityUnavailable);
  assert.equal(hits, 3, 'REFRESH_RETRY_POLICY.attempts');
});

test('boot gets the shorter ladder, because it runs inside the 8s handshake', async () => {
  // The wasSignedIn flag is seeded because counting BOOT_RETRY_POLICY's attempts
  // needs the failure path to throw. On a never-signed-in install a boot failure
  // resolves `undefined` instead, which is what the next test covers.
  let hits = 0;
  const { storage, m } = memory();
  m.set(wasSignedInKey('k'), '1');
  const p = createIdentityProvider({
    embedKey: 'k',
    storage,
    identity: { endpoint: 'https://x/y' },
    fetchImpl: (async () => {
      hits++;
      throw new Error('network');
    }) as typeof fetch,
    sleep: async () => {},
    random: () => 1,
  });
  await assert.rejects(p.initial(), IdentityUnavailable);
  assert.equal(hits, 2, 'BOOT_RETRY_POLICY.attempts — an 8s boot ladder times the handshake out');
});

test('boot failure on a never-signed-in install is anonymous, not an error', async () => {
  const p = make({
    identity: { endpoint: 'https://x/y' },
    fetchImpl: (async () => {
      throw new Error('network');
    }) as typeof fetch,
    sleep: async () => {},
    random: () => 1,
  });
  assert.equal(await p.initial(), undefined, 'a first launch offline still boots anonymous');
});

test('a token obtained once sets wasSignedIn, and a later boot failure then throws', async () => {
  const { m, storage } = memory();
  let up = true;
  const p = createIdentityProvider({
    embedKey: 'k',
    storage,
    identity: { endpoint: 'https://x/y' },
    fetchImpl: (async () => {
      if (!up) throw new Error('network');
      return { ok: true, json: async () => ({ token: jwt(2000000000) }) } as unknown as Response;
    }) as typeof fetch,
    sleep: async () => {},
    random: () => 1,
  });
  assert.ok(await p.initial());
  assert.ok(m.get(wasSignedInKey('k')), 'the flag is what survives the process, not the token');
  up = false;
  // A fresh provider over the same storage: the app was killed and relaunched offline.
  const p2 = createIdentityProvider({
    embedKey: 'k',
    storage,
    identity: { endpoint: 'https://x/y' },
    fetchImpl: (async () => {
      throw new Error('network');
    }) as typeof fetch,
    sleep: async () => {},
    random: () => 1,
  });
  await assert.rejects(
    p2.initial(),
    IdentityUnavailable,
    "answering the handshake without a token would orphan this user's threads",
  );
});

test('clear drops the flag so the next boot is allowed to be anonymous again', async () => {
  const { m, storage } = memory();
  const p = createIdentityProvider({
    embedKey: 'k',
    storage,
    identity: { getToken: () => jwt(2000000000) },
  });
  await p.initial();
  assert.ok(m.get(wasSignedInKey('k')));
  await p.clear();
  assert.equal(
    m.get(wasSignedInKey('k')),
    undefined,
    'logout rotates the install id into a new anonymous user; a stale flag would refuse to boot it',
  );
});

test('a token with no readable exp is returned but never cached', async () => {
  let hits = 0;
  const p = make({
    identity: { endpoint: 'https://x/y' },
    fetchImpl: (async () => {
      hits++;
      return { ok: true, json: async () => ({ token: 'opaque-not-a-jwt' }) } as unknown as Response;
    }) as typeof fetch,
  });
  assert.equal(await p.initial(), 'opaque-not-a-jwt');
  await p.refresh();
  assert.equal(hits, 2, 'no expiry means no safe reuse window');
});

test('warns in dev when exp - iat exceeds 3600s, because the mint will reject it', async () => {
  const warnings: string[] = [];
  const long = jwt(2_000_003_601, 2_000_000_000);
  const p = make({ identity: { getToken: () => long }, warn: (m) => warnings.push(m) });
  await p.initial();
  assert.equal(warnings.length, 1);
});

test('a failed wasSignedIn flag write does not fail an otherwise-successful boot', async () => {
  const storage: MentioraStorage = {
    getItem: async () => null,
    setItem: async () => {
      throw new Error('disk full');
    },
    removeItem: async () => {},
  };
  const p = createIdentityProvider({
    embedKey: 'k',
    storage,
    identity: { getToken: () => jwt(2000000000) },
  });
  assert.ok(
    await p.initial(),
    'the caller already has a token; a flag-write failure is not its problem',
  );
});

// Two invariants the rest of the file leaves unasserted: a token must not outlive
// a logout, and the token must never touch storage.

test('clear drops the cached token too, so the next user never inherits it', async () => {
  // The fetcher shape is the only one with a reuse window: `refresh()` on a
  // `getToken` provider always re-calls, so the same test written against it
  // passes with the cache left fully intact.
  const now = 1_000_000_000_000;
  let hits = 0;
  const p = make({
    identity: { endpoint: 'https://x/y' },
    now: () => now,
    fetchImpl: (async () => {
      hits++;
      return {
        ok: true,
        json: async () => ({ token: jwt(now / 1000 + 3600) }),
      } as unknown as Response;
    }) as typeof fetch,
  });
  await p.initial();
  await p.refresh(); // an hour left, far outside the 5-minute floor: served from cache
  assert.equal(hits, 1, 'precondition: there IS a live cache to clear');

  await p.clear();

  await p.refresh();
  assert.equal(hits, 2, 'a token cached before a logout must never be handed to the next user');
});

test('the only value ever written under the wasSignedIn key is the flag, never the token', async () => {
  // The token lives in memory only. `assert.ok(m.get(...))` above is truthy for a
  // JWT just as happily as for '1', so it does not pin that down.
  const { m, storage } = memory();
  const written: string[] = [];
  const watched: MentioraStorage = {
    ...storage,
    setItem: async (k, v) => {
      if (k === wasSignedInKey('k')) written.push(v);
      await storage.setItem(k, v);
    },
  };
  const token = jwt(2000000000);
  const p = createIdentityProvider({
    embedKey: 'k',
    storage: watched,
    identity: { getToken: () => token },
  });
  await p.initial();
  await p.refresh();

  assert.deepEqual(written, ['1', '1']);
  assert.ok(![...m.values()].includes(token), 'the token must never reach storage');
});

// `mintToken` writes `cache` and the `wasSignedIn` marker behind a generation
// check. Without one, a `refresh()`/`initial()` sitting in `retry`, `fetch`, a
// retry sleep or response parsing when `clear()` runs resumes afterwards and puts
// both back, and the next boot reuses a pre-logout token.
test('a mint that resumes after clear() repopulates neither the cache nor the marker', async () => {
  const { m, storage } = memory();
  let calls = 0;
  let release!: (t: string) => void;
  const p = createIdentityProvider({
    embedKey: 'k',
    storage,
    identity: {
      getToken: () => {
        calls++;
        return calls === 1
          ? new Promise<string>((res) => {
              release = res;
            })
          : jwt(2000000000);
      },
    },
  });

  const inFlight = p.refresh(); // parked inside getToken
  await p.clear(); // the user logs out while it is parked
  release(jwt(2000000000));

  await assert.rejects(inFlight, IdentityUnavailable);
  assert.equal(m.get(wasSignedInKey('k')), undefined, 'the marker must not come back');

  // And nothing was cached: a surviving pre-logout token would be handed back
  // here with no second fetch.
  await p.refresh();
  assert.equal(calls, 2, 'the pre-logout token must not be reused from cache');
});

test('a mint whose marker write lands after clear() undoes it', async () => {
  const { m, storage } = memory();
  let releaseWrite!: () => void;
  const slowWrite: MentioraStorage = {
    ...storage,
    setItem: async (k, v) => {
      await new Promise<void>((res) => {
        releaseWrite = res;
      });
      await storage.setItem(k, v);
    },
  };
  const p = createIdentityProvider({
    embedKey: 'k',
    storage: slowWrite,
    identity: { getToken: () => jwt(2000000000) },
  });

  const inFlight = p.refresh(); // parked inside storage.setItem
  await new Promise((r) => setImmediate(r));
  await p.clear();
  releaseWrite();
  await assert.rejects(inFlight, IdentityUnavailable);
  assert.equal(m.get(wasSignedInKey('k')), undefined, 'a marker set post-logout deadlocks boot');
});

test('an uninterrupted mint still caches and still writes the marker', async () => {
  const { m, storage } = memory();
  let calls = 0;
  const p = createIdentityProvider({
    embedKey: 'k',
    storage,
    identity: { endpoint: 'https://api.example.com/token' },
    fetchImpl: (async () => {
      calls++;
      return {
        ok: true,
        json: async () => ({ token: jwt(2000000000) }),
      } as unknown as Response;
    }) as typeof fetch,
  });
  assert.equal(typeof (await p.initial()), 'string');
  assert.equal(m.get(wasSignedInKey('k')), '1');
  await p.refresh();
  assert.equal(calls, 1, 'the cache still works when no logout intervened');
});

// `initial()` reads the marker before returning anonymous on `!identity`.
// Returning first demotes a signed-in install that restarts while identity is not
// yet configured to a fresh anonymous user, orphaning its threads — the failure
// the marker exists to prevent.
test('a signed-in install with no identity configured fails the handshake', async () => {
  const { m, storage } = memory();
  m.set(wasSignedInKey('k'), '1');
  const p = createIdentityProvider({ embedKey: 'k', storage });
  await assert.rejects(p.initial(), IdentityUnavailable);
});

test('an install that was never signed in still boots anonymous with no identity', async () => {
  const { storage } = memory();
  const p = createIdentityProvider({ embedKey: 'k', storage });
  assert.equal(await p.initial(), undefined);
});

// The test above still passes with the post-`retry` `cleared()` check deleted,
// because its assertions are satisfied by the two later checks. That check is the
// only thing keeping `cache` from holding a pre-logout token during the
// `await storage.setItem` window, where a concurrent `refresh()` on a fetcher-shape
// provider takes the `isFresh` shortcut straight into it.
test('a mint resuming after clear() never publishes its token, not even transiently', async () => {
  const now = 1_000_000_000_000;
  const tokenA = jwt(now / 1000 + 3600);
  const tokenB = jwt(now / 1000 + 3601);
  const { storage } = memory();

  let releaseFetch!: () => void;
  const fetched = new Promise<void>((r) => {
    releaseFetch = r;
  });
  let releaseWrite!: () => void;
  const written = new Promise<void>((r) => {
    releaseWrite = r;
  });
  let firstWrite = true;
  const slowWrite: MentioraStorage = {
    ...storage,
    setItem: async (k, v) => {
      if (firstWrite) {
        firstWrite = false;
        await written; // whichever mint gets here first parks, holding the window open
      }
      await storage.setItem(k, v);
    },
  };

  let hits = 0;
  const p = createIdentityProvider({
    embedKey: 'k',
    storage: slowWrite,
    identity: { endpoint: 'https://x/y' },
    now: () => now,
    fetchImpl: (async () => {
      const mine = ++hits;
      if (mine === 1) await fetched;
      return {
        ok: true,
        json: async () => ({ token: mine === 1 ? tokenA : tokenB }),
      } as unknown as Response;
    }) as typeof fetch,
  });

  const inFlight = p.refresh(); // parked inside fetchImpl
  inFlight.catch(() => undefined);
  await new Promise((r) => setImmediate(r));
  await p.clear(); // the user logs out while it is parked
  releaseFetch();
  await new Promise((r) => setImmediate(r));

  const second = p.refresh();
  second.catch(() => undefined);
  await new Promise((r) => setImmediate(r));
  assert.equal(hits, 2, 'the pre-logout token must never be reachable through the cache');

  releaseWrite();
  assert.equal(await second, tokenB);
  await assert.rejects(inFlight, IdentityUnavailable);
});

// A stale mint's undo is scoped to its own generation. Unscoped, it removes
// whatever marker is in storage and wipes whatever token is cached, even when both
// belong to a newer mint that has already completed, leaving a signed-in install
// with no marker that a later boot failure demotes to anonymous.
test("a stale mint's undo cannot erase a newer mint's marker or cache", async () => {
  const now = 1_000_000_000_000;
  const tokenA = jwt(now / 1000 + 3600);
  const tokenB = jwt(now / 1000 + 3601);
  const { m, storage } = memory();

  let releaseWrite!: () => void;
  const written = new Promise<void>((r) => {
    releaseWrite = r;
  });
  let firstWrite = true;
  const slowFirstWrite: MentioraStorage = {
    ...storage,
    setItem: async (k, v) => {
      if (firstWrite) {
        firstWrite = false;
        await written;
      }
      await storage.setItem(k, v);
    },
  };

  let hits = 0;
  const p = createIdentityProvider({
    embedKey: 'k',
    storage: slowFirstWrite,
    identity: { endpoint: 'https://x/y' },
    now: () => now,
    fetchImpl: (async () => {
      const mine = ++hits;
      return {
        ok: true,
        json: async () => ({ token: mine === 1 ? tokenA : tokenB }),
      } as unknown as Response;
    }) as typeof fetch,
  });

  const stale = p.refresh(); // reaches setItem and parks there
  stale.catch(() => undefined);
  await new Promise((r) => setImmediate(r));

  await p.clear(); // logout
  await p.refresh(); // the user signs back in; this mint completes in full
  assert.equal(m.get(wasSignedInKey('k')), '1', 'precondition: the new mint marked the install');

  releaseWrite(); // the pre-logout mint finally resumes
  await assert.rejects(stale, IdentityUnavailable);

  assert.equal(m.get(wasSignedInKey('k')), '1', "the newer mint's marker must survive");
  const before = hits;
  await p.refresh();
  assert.equal(hits, before, "the newer mint's cache must survive too");
});
