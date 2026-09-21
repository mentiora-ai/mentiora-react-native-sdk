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
  // NOTE (deviation from the brief's literal test): the brief's version of this
  // test used a fresh, never-signed-in install and asserted that p.initial()
  // REJECTS with IdentityUnavailable. That directly contradicts the very next
  // test ("boot failure on a never-signed-in install is anonymous, not an
  // error") and the brief's own §2.3/resolution #2: a boot failure on an
  // install that was never signed in must resolve `undefined`, not throw.
  // This test's actual purpose (per its title/comment) is to verify
  // BOOT_RETRY_POLICY's attempt count, which requires a signed-in install so
  // the failure path throws instead of falling back to anonymous. Seeding the
  // wasSignedIn flag preserves that intent under the correct implementation.
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
