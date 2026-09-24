/**
 * The shared runtime, one per embed key. WebView, peer and session key are per
 * page load; storage, the install id and the identity provider are shared per
 * `embedKey` so a widget and a `Mentiora.open()` Modal are the same anonymous user.
 */
import { createIdentityProvider, type IdentityProvider, type LogoutEpoch } from './identity.js';
import { loadOrCreateInstallId, rotateInstallId } from './install-id.js';
import { resolveStorage, type StorageStatus } from './storage.js';
import type { MentioraConfig, MentioraIdentity, MentioraStorage } from './types.js';
import { parseWidgetUrl } from './widget-url.js';

/** 16 random bytes, from the WebView that is asking. */
export type RandomBytes = (n: number) => Promise<Uint8Array>;

export type MentioraRuntime = {
  /** Single-flight; uses the calling WebView's random source. */
  installId: (randomBytes: RandomBytes) => Promise<string>;
  identity: IdentityProvider;
  /** `resolveStorage`'s result minus the store, discriminated on `ephemeral`. */
  storage: StorageStatus;
  /** Rotates the install id and clears identity; subscribers reload. */
  logout: () => Promise<void>;
  /**
   * Reloads every mounted widget without touching the install id or the identity cache.
   * A warm page keeps the credential it booted with, and only a new document runs
   * `initialize` again — so a changed identity has to force one.
   */
  reload: () => void;
  onReload: (fn: () => void) => () => void;
};

type RuntimeEntry = {
  runtime: MentioraRuntime;
  storage: MentioraStorage;
  embedKey: string;
  /** The `config.identity` reference the live provider was built from. */
  identityRef: MentioraIdentity | undefined;
  epoch: LogoutEpoch;
};

const runtimes = new Map<string, RuntimeEntry>();

/** Tests only. */
export const __resetRuntimes = (): void => {
  runtimes.clear();
};

const buildEntry = (config: MentioraConfig, embedKey: string): RuntimeEntry => {
  const epoch: LogoutEpoch = { n: 0 };
  const resolved = resolveStorage(config.storage);
  const { storage } = resolved;

  // Memoises the in-flight promise so two concurrent first callers share one id.
  // `randomBytes` is per call: a captured one may belong to an unmounted page.
  let inFlight: Promise<string> | undefined;
  // Set during `logout()`'s rotation and awaited by every new mint, or a call
  // could re-read the old id before `removeItem` lands.
  let rotation: Promise<void> | undefined;
  const installId = (randomBytes: RandomBytes): Promise<string> => {
    if (!inFlight) {
      const pendingRotation = rotation;
      // Conditional reset: this mint can settle after a post-logout caller
      // installed a newer memo.
      const p: Promise<string> = (async () => {
        await pendingRotation;
        return await loadOrCreateInstallId({ storage, embedKey, randomBytes });
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

  const runtime: MentioraRuntime = {
    reload: () => {
      for (const fn of subscribers) fn();
    },
    installId,
    identity: createIdentityProvider({ identity: config.identity, embedKey, storage, epoch }),
    storage: resolved.ephemeral
      ? { ephemeral: true, reason: resolved.reason, detail: resolved.detail }
      : { ephemeral: false, reason: resolved.reason },
    onReload,
    logout: async () => {
      // Captured before the first await; a provider swapped in mid-rotation is
      // cleared separately below.
      const clearing = runtime.identity;
      // Wait for the prior mint to settle: one blocked in `setItem` would
      // otherwise commit after `removeItem` and survive the rotation.
      const prior = inFlight;
      inFlight = undefined;
      const rotating = (async () => {
        await prior?.catch(() => undefined);
        await rotateInstallId({ storage, embedKey });
      })();
      // Caught, so a rejected `removeItem` is not re-thrown by every later
      // `installId()` for the life of the process.
      rotation = rotating.catch(() => undefined);
      // Errors are collected so the clear and the subscribers still run.
      const errors: unknown[] = [];
      try {
        await rotating;
      } catch (err) {
        errors.push(err);
      } finally {
        rotation = undefined;
      }
      try {
        await clearing.clear();
        const live = runtime.identity;
        if (live !== clearing) await live.clear();
      } catch (err) {
        errors.push(err);
      } finally {
        for (const fn of subscribers) fn();
      }
      if (errors.length > 0) throw errors[0];
    },
  };

  return { runtime, storage, embedKey, identityRef: config.identity, epoch };
};

/** One runtime per `embedKey`. A new `config.identity` reference swaps in a
 *  fresh provider without clearing the old one, which would drop `wasSignedIn`.
 *  Only `identity` is reconciled; a new `config.storage` would strand the id. */
export const getRuntime = (config: MentioraConfig): MentioraRuntime => {
  const { embedKey } = parseWidgetUrl(config.widgetUrl);
  const existing = runtimes.get(embedKey);
  if (existing) {
    if (existing.identityRef !== config.identity) {
      existing.runtime.identity = createIdentityProvider({
        identity: config.identity,
        embedKey: existing.embedKey,
        storage: existing.storage,
        epoch: existing.epoch,
      });
      existing.identityRef = config.identity;
    }
    return existing.runtime;
  }
  const entry = buildEntry(config, embedKey);
  runtimes.set(embedKey, entry);
  return entry.runtime;
};
