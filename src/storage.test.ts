import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MentioraStorage } from './storage.js';
import { defaultLoad, resolveStorage } from './storage.js';

const stub = (): MentioraStorage => ({
  getItem: async () => null,
  setItem: async () => {},
  removeItem: async () => {},
});

test('an explicit override wins and load() is never consulted', () => {
  const override = stub();
  let loaded = 0;
  const r = resolveStorage(override, () => {
    loaded++;
    return stub();
  });
  assert.equal(r.storage, override);
  assert.equal(r.ephemeral, false);
  assert.equal(r.reason, 'override');
  assert.equal(loaded, 0, 'a caller that supplied storage must not pay for the optional peer');
});

test('a load() that returns a store is used and is not ephemeral', () => {
  const peer = stub();
  const r = resolveStorage(undefined, () => peer);
  assert.equal(r.storage, peer);
  assert.equal(r.ephemeral, false);
  assert.equal(r.reason, 'peer-loaded');
});

test('a load() that throws falls back to memory instead of propagating', () => {
  const r = resolveStorage(undefined, () => {
    throw new Error('module not installed');
  });
  assert.equal(r.ephemeral, true, 'the caller warns and emits onEvent off this flag');
  assert.equal(
    r.reason,
    'load-threw',
    'a custom load throwing is distinct from a clean peer-absent null',
  );
  assert.equal(
    r.detail,
    'module not installed',
    'the caught error is retained for a later __DEV__ diagnostic',
  );
});

test('a load() that returns null falls back to memory', () => {
  const r = resolveStorage(undefined, () => null);
  assert.equal(r.ephemeral, true);
  assert.equal(r.reason, 'peer-absent');
});

test('defaultLoad throws a tagged error when require is unavailable, instead of silently returning null', () => {
  assert.throws(() => defaultLoad(() => false));
});

test('resolveStorage tags a missing require distinctly from a generic load throw (the ESM-build case)', () => {
  const r = resolveStorage(undefined, () => defaultLoad(() => false));
  assert.equal(r.ephemeral, true);
  assert.equal(
    r.reason,
    'no-require',
    'a build with no synchronous require cannot auto-resolve storage at all — ' +
      'distinct from the peer simply not being installed',
  );
  assert.ok(r.detail && r.detail.length > 0);
});

test('the in-memory fallback round-trips and forgets on removeItem', async () => {
  const { storage } = resolveStorage(undefined, () => null);
  assert.equal(await storage.getItem('k'), null);
  await storage.setItem('k', 'v');
  assert.equal(await storage.getItem('k'), 'v');
  await storage.removeItem('k');
  assert.equal(await storage.getItem('k'), null);
});

test('two resolutions do not share one in-memory store', async () => {
  const a = resolveStorage(undefined, () => null);
  const b = resolveStorage(undefined, () => null);
  await a.storage.setItem('k', 'v');
  assert.equal(
    await b.storage.getItem('k'),
    null,
    'a module-level Map would leak across embed keys',
  );
});

// --- External review, m1 ---
//
// Every throw out of the peer `require` used to be tagged `peer-absent`, and
// that reason is what the public `storageUnavailable` event carries: an
// async-storage that failed to initialise, or that was missing a transitive
// dependency of its own, told the customer to install a package they already
// have.
const moduleNotFound = (message: string): Error =>
  Object.assign(new Error(message), { code: 'MODULE_NOT_FOUND' });

test('a MODULE_NOT_FOUND naming the peer itself is peer-absent', () => {
  const r = resolveStorage(undefined, () =>
    defaultLoad(
      () => true,
      () => {
        throw moduleNotFound(
          "Cannot find module '@react-native-async-storage/async-storage'\nRequire stack:\n- /app/index.js",
        );
      },
    ),
  );
  assert.equal(r.ephemeral, true);
  assert.equal(r.reason, 'peer-absent');
});

test('a MODULE_NOT_FOUND naming something ELSE is load-threw, not peer-absent', () => {
  const r = resolveStorage(undefined, () =>
    defaultLoad(
      () => true,
      () => {
        // Node's real shape for a transitive miss: the stack names the peer
        // that IS installed, one line below the module that is not (F11).
        throw moduleNotFound(
          "Cannot find module 'some-transitive-dep'\nRequire stack:\n" +
            '- /app/node_modules/@react-native-async-storage/async-storage/lib/index.js\n' +
            '- /app/node_modules/other/index.js',
        );
      },
    ),
  );
  assert.equal(r.reason, 'load-threw', 'the peer IS installed — it just could not load');
  assert.match(r.detail ?? '', /some-transitive-dep/);
});

test('an initialisation failure inside the peer is load-threw', () => {
  const r = resolveStorage(undefined, () =>
    defaultLoad(
      () => true,
      () => {
        throw new Error('NativeModule: AsyncStorage is null');
      },
    ),
  );
  assert.equal(r.reason, 'load-threw');
  assert.match(r.detail ?? '', /AsyncStorage is null/);
});

test('a peer that loads is still used through the seam', () => {
  const peer = stub();
  const r = resolveStorage(undefined, () =>
    defaultLoad(
      () => true,
      () => ({ default: peer }),
    ),
  );
  assert.equal(r.storage, peer);
  assert.equal(r.reason, 'peer-loaded');
});
