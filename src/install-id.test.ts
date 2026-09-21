import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installIdKey, loadOrCreateInstallId, rotateInstallId } from './install-id.js';

const memory = () => {
  const m = new Map<string, string>();
  return {
    m,
    getItem: async (k: string) => m.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      m.set(k, v);
    },
    removeItem: async (k: string) => {
      m.delete(k);
    },
  };
};
const bytes = async (n: number) => new Uint8Array(n).fill(9);

test('the key is scoped per embed key so two widgets never share one', () => {
  assert.notEqual(installIdKey('pk_wgt_a'), installIdKey('pk_wgt_b'));
  assert.equal(installIdKey('pk_wgt_a'), 'mentiora.installId.pk_wgt_a');
});

test('creates on first launch, 16 bytes base64url, and persists it', async () => {
  const s = memory();
  const id = await loadOrCreateInstallId({ storage: s, embedKey: 'pk_wgt_a', randomBytes: bytes });
  assert.ok(!/[+/=]/.test(id));
  assert.equal(s.m.get('mentiora.installId.pk_wgt_a'), id);
});

test('returns the same id on the second launch', async () => {
  const s = memory();
  const a = await loadOrCreateInstallId({ storage: s, embedKey: 'k', randomBytes: bytes });
  const b = await loadOrCreateInstallId({ storage: s, embedKey: 'k', randomBytes: bytes });
  assert.equal(a, b);
});

test('rotate deletes it so the next launch mints a new anonymous user', async () => {
  const s = memory();
  const a = await loadOrCreateInstallId({ storage: s, embedKey: 'k', randomBytes: bytes });
  await rotateInstallId({ storage: s, embedKey: 'k' });
  assert.equal(s.m.get('mentiora.installId.k'), undefined);
  const b = await loadOrCreateInstallId({
    storage: s,
    embedKey: 'k',
    randomBytes: async (n) => new Uint8Array(n).fill(4),
  });
  assert.notEqual(a, b);
});
