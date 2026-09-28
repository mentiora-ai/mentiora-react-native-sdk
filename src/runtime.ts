/** Shared per `embedKey` so an inline widget and the `Mentiora.open()` overlay are the same
 *  anonymous user. WebView, peer and session key stay per page load. */
import { createIdentityProvider, type IdentityProvider, type LogoutEpoch } from './identity.js';
import {
  installIdKey,
  installRefOf,
  loadOrCreateInstallId,
  rotateInstallId,
} from './install-id.js';
import { resolveStorage, type StorageStatus } from './storage.js';
import type { MentioraConfig, MentioraIdentity, MentioraStorage } from './types.js';
import { parseWidgetUrl } from './widget-url.js';

export type RandomBytes = (n: number) => Promise<Uint8Array>;

export type MentioraRuntime = {
  /** Single-flight; uses the calling WebView's random source. */
  installId: (randomBytes: RandomBytes) => Promise<string>;
  /** The stored id's `installRef`, or `null` when none exists. Never mints one. */
  installRef: () => Promise<string | null>;
  /** The new `installRef` when an id is minted; `null` when logout deletes it. */
  onInstallRefChange: (fn: (installRef: string | null) => void) => () => void;
  identity: IdentityProvider;
  storage: StorageStatus;
  logout: () => Promise<void>;
  /** A warm page keeps the credential it booted with; only a new document re-runs
   *  `initialize`, so a changed identity has to force a reload. */
  reload: () => void;
  onReload: (fn: () => void) => () => void;
};

type RuntimeEntry = {
  runtime: MentioraRuntime;
  storage: MentioraStorage;
  embedKey: string;
  identityRef: MentioraIdentity | undefined;
  epoch: LogoutEpoch;
};

const runtimes = new Map<string, RuntimeEntry>();

export const __resetRuntimes = (): void => {
  runtimes.clear();
};

const providerFor = (
  entry: Pick<RuntimeEntry, 'embedKey' | 'storage' | 'epoch'>,
  identity: MentioraIdentity | undefined,
): IdentityProvider =>
  createIdentityProvider({
    identity,
    embedKey: entry.embedKey,
    storage: entry.storage,
    epoch: entry.epoch,
  });

const buildEntry = (config: MentioraConfig, embedKey: string): RuntimeEntry => {
  const epoch: LogoutEpoch = { n: 0 };
  const resolved = resolveStorage(config.storage);
  const { storage } = resolved;

  // `randomBytes` is per call: a captured one may belong to an unmounted page.
  let inFlight: Promise<string> | undefined;
  // Set during `logout()`'s rotation and awaited by every new mint, or a call
  // could re-read the old id before `removeItem` lands.
  let rotation: Promise<void> | undefined;

  const refListeners = new Set<(installRef: string | null) => void>();
  const emitRef = (installRef: string | null): void => {
    for (const fn of refListeners) {
      try {
        fn(installRef);
      } catch {
        // A throwing host callback must not fail the mint or the logout.
      }
    }
  };
  const onCreated = (id: string): void => emitRef(installRefOf(id));

  const installId = (randomBytes: RandomBytes): Promise<string> => {
    if (!inFlight) {
      const pendingRotation = rotation;
      // Conditional: this mint can settle after a post-logout caller set a newer memo.
      const p: Promise<string> = (async () => {
        await pendingRotation;
        return await loadOrCreateInstallId({ storage, embedKey, randomBytes, onCreated });
      })().finally(() => {
        if (inFlight === p) inFlight = undefined;
      });
      inFlight = p;
    }
    return inFlight;
  };

  const subscribers = new Set<() => void>();
  const onReload = (fn: () => void): (() => void) => {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  };
  const reload = (): void => {
    for (const fn of subscribers) fn();
  };

  // Wait for the prior mint to settle: one blocked in `setItem` would otherwise
  // commit after `removeItem` and survive the rotation.
  const rotate = async (): Promise<void> => {
    const prior = inFlight;
    inFlight = undefined;
    const rotating = (async () => {
      await prior?.catch(() => undefined);
      await rotateInstallId({ storage, embedKey });
    })();
    // Caught, or a rejected `removeItem` is re-thrown by every later `installId()`.
    rotation = rotating.catch(() => undefined);
    try {
      await rotating;
      emitRef(null);
    } finally {
      rotation = undefined;
    }
  };

  // `clearing` was live when logout began; a provider swapped in mid-rotation is cleared too.
  const clearIdentities = async (clearing: IdentityProvider): Promise<void> => {
    await clearing.clear();
    const live = runtime.identity;
    if (live !== clearing) await live.clear();
  };

  const runtime: MentioraRuntime = {
    reload,
    installId,
    installRef: async () => {
      // A read mid-logout would otherwise return the id being deleted.
      await rotation;
      const id = await storage.getItem(installIdKey(embedKey));
      return id === null ? null : installRefOf(id);
    },
    onInstallRefChange: (fn) => {
      refListeners.add(fn);
      return () => refListeners.delete(fn);
    },
    identity: providerFor({ embedKey, storage, epoch }, config.identity),
    storage: resolved.ephemeral
      ? { ephemeral: true, reason: resolved.reason, detail: resolved.detail }
      : { ephemeral: false, reason: resolved.reason },
    onReload,
    logout: async () => {
      const clearing = runtime.identity;
      // Both halves run even if the first fails; the first failure is re-thrown.
      const errors: unknown[] = [];
      await rotate().catch((err: unknown) => errors.push(err));
      await clearIdentities(clearing).catch((err: unknown) => errors.push(err));
      reload();
      if (errors.length > 0) throw errors[0];
    },
  };

  return { runtime, storage, embedKey, identityRef: config.identity, epoch };
};

/** A new `config.identity` swaps in a fresh provider without clearing the old one (that
 *  would drop `wasSignedIn`). A new `config.storage` is ignored: it would strand the id. */
export const getRuntime = (config: MentioraConfig): MentioraRuntime => {
  const { embedKey } = parseWidgetUrl(config.widgetUrl);
  const existing = runtimes.get(embedKey);
  if (existing) {
    if (existing.identityRef !== config.identity) {
      existing.runtime.identity = providerFor(existing, config.identity);
      existing.identityRef = config.identity;
    }
    return existing.runtime;
  }
  const entry = buildEntry(config, embedKey);
  runtimes.set(embedKey, entry);
  return entry.runtime;
};
