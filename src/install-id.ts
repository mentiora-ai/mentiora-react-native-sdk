/** The anonymous user's identity: the server keys the user and their threads
 *  to it. Stored per `embedKey`. */

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

/** Deletes the id; the next `loadOrCreateInstallId` mints the replacement. */
export const rotateInstallId = async (deps: {
  storage: MentioraStorage;
  embedKey: string;
}): Promise<void> => {
  await deps.storage.removeItem(installIdKey(deps.embedKey));
};
