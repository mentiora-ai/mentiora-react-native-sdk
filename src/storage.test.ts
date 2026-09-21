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
