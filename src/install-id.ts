/**
 * The install id is the SDK's anonymous user identity: on first launch with
 * no signed-in user, the widget's server mints an anonymous user keyed to it,
 * and every thread that user creates hangs off it. Scoped per `embedKey`, so
 * an app embedding two widgets never has them share one anonymous user.
 */

import { toBase64Url } from './random.js';
import type { MentioraStorage } from './types.js';

export const installIdKey = (embedKey: string): string => `mentiora.installId.${embedKey}`;

export const loadOrCreateInstallId = async (deps: {
  storage: MentioraStorage;
  embedKey: string;
  randomBytes: (n: number) => Promise<Uint8Array>;
}): Promise<string> => {
  const key = installIdKey(deps.embedKey);
  const existing = await deps.storage.getItem(key);
  if (existing !== null) return existing;
  const id = toBase64Url(await deps.randomBytes(16));
  await deps.storage.setItem(key, id);
  return id;
};

/** Deletes the install id without minting a new one; the next
 *  `loadOrCreateInstallId` does that, keeping logout's two effects — rotate
 *  now, mint on next use — separable. */
export const rotateInstallId = async (deps: {
  storage: MentioraStorage;
  embedKey: string;
}): Promise<void> => {
  await deps.storage.removeItem(installIdKey(deps.embedKey));
};
