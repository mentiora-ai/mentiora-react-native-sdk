import { toBase64Url } from './base64url.js';
import { sha256Hex } from './sha256.js';
import type { MentioraStorage } from './types.js';

export const installIdKey = (embedKey: string): string => `mentiora.installId.${embedKey}`;

export const loadOrCreateInstallId = async (deps: {
  storage: MentioraStorage;
  embedKey: string;
  randomBytes: (n: number) => Promise<Uint8Array>;
  /** Called after a new id is persisted, never for one read back. */
  onCreated?: (id: string) => void;
}): Promise<string> => {
  const key = installIdKey(deps.embedKey);
  const existing = await deps.storage.getItem(key);
  if (existing !== null) return existing;
  const id = toBase64Url(await deps.randomBytes(16));
  await deps.storage.setItem(key, id);
  deps.onCreated?.(id);
  return id;
};

export const rotateInstallId = async (deps: {
  storage: MentioraStorage;
  embedKey: string;
}): Promise<void> => {
  await deps.storage.removeItem(installIdKey(deps.embedKey));
};

const INSTALL_REF_LABEL = 'mentiora:install-ref:v1';

/** Public stand-in for `installId`, a bearer credential that never leaves the SDK; the
 *  backend derives the same value. base64url input, so UTF-8 bytes are its char codes. */
export const installRefOf = (installId: string): string => {
  const input = `${INSTALL_REF_LABEL}\u0000${installId}`;
  return sha256Hex(new Uint8Array([...input].map((c) => c.charCodeAt(0))));
};
