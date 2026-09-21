import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MentioraStorage } from './storage.js';
import { resolveStorage } from './storage.js';

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
  assert.equal(loaded, 0, 'a caller that supplied storage must not pay for the optional peer');
});

test('a load() that returns a store is used and is not ephemeral', () => {
  const peer = stub();
  const r = resolveStorage(undefined, () => peer);
  assert.equal(r.storage, peer);
  assert.equal(r.ephemeral, false);
});

test('a load() that throws falls back to memory instead of propagating', () => {
  const r = resolveStorage(undefined, () => {
    throw new Error('module not installed');
  });
  assert.equal(r.ephemeral, true, 'the caller warns and emits onEvent off this flag');
});

test('a load() that returns null falls back to memory', () => {
  assert.equal(resolveStorage(undefined, () => null).ephemeral, true);
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
