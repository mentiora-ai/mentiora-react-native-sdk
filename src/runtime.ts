/**
 * The shared runtime, one per embed key. WebView, peer and session key are per
 * page load; storage, the install id and the identity provider are shared per
 * `embedKey`, or a widget and a `Mentiora.open()` Modal each mint an id and
 * become two anonymous users.
 */
import { createIdentityProvider, type IdentityProvider, type LogoutEpoch } from './identity.js';
import { loadOrCreateInstallId, rotateInstallId } from './install-id.js';
import { resolveStorage, type StorageStatus } from './storage.js';
import type { MentioraConfig, MentioraIdentity, MentioraStorage } from './types.js';

/** 16 random bytes, from the WebView that is asking. */
export type RandomBytes = (n: number) => Promise<Uint8Array>;

export type MentioraRuntime = {
  /** Single-flight; takes the CALLER's random source, never a captured one. */
  installId: (randomBytes: RandomBytes) => Promise<string>;
  identity: IdentityProvider;
  /** `resolveStorage`'s result minus the store, discriminated on `ephemeral`. */
  storage: StorageStatus;
  logout: () => Promise<void>; // rotate + clear identity; reloads are the caller's job
  onReload: (fn: () => void) => () => void; // mounted widgets subscribe
};

type RuntimeEntry = {
  runtime: MentioraRuntime;
  storage: MentioraStorage;
  embedKey: string;
  /** The `config.identity` reference the live provider was built from. */
  identityRef: MentioraIdentity | undefined;
  /** Shared by every provider this entry owns, so a mint parked in a discarded
   *  one cannot write `wasSignedIn` after a logout. */
  epoch: LogoutEpoch;
};

const runtimes = new Map<string, RuntimeEntry>();

/** Tests only. Clears every cached runtime so each test starts from nothing. */
export const __resetRuntimes = (): void => {
  runtimes.clear();
};

const buildEntry = (config: MentioraConfig): RuntimeEntry => {
  const { embedKey } = config;
  const epoch: LogoutEpoch = { n: 0 };
  const resolved = resolveStorage(config.storage);
  const { storage } = resolved;

  // Single-flight over the IN-FLIGHT PROMISE, not the value, or two first
  // callers each mint an id. `randomBytes` is per call: a captured one injects
  // into a page that may be busy or already unmounted.
  let inFlight: Promise<string> | undefined;
  // Held for a `logout()`'s rotation and awaited by every new mint: dropping
  // the memo alone lets a call re-memoise the old id before `removeItem`.
  let rotation: Promise<void> | undefined;
  const installId = (randomBytes: RandomBytes): Promise<string> => {
    if (!inFlight) {
      const pendingRotation = rotation;
      // `if (inFlight === p)`, never an unconditional null: this mint can
      // settle after a post-logout caller installed a newer memo.
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
    installId,
    identity: createIdentityProvider({ identity: config.identity, embedKey, storage, epoch }),
    storage: resolved.ephemeral
      ? { ephemeral: true, reason: resolved.reason, detail: resolved.detail }
      : { ephemeral: false, reason: resolved.reason },
    onReload,
    logout: async () => {
      // Captured before the first await, or a provider swapped in mid-rotation
      // escapes the logout. The one live at the end is cleared too, below.
      const clearing = runtime.identity;
      // Let the prior mint SETTLE before the delete, unbounded: a mint blocked
      // in `setItem` would commit after `removeItem` and survive its rotation.
      const prior = inFlight;
      inFlight = undefined;
      const rotating = (async () => {
        await prior?.catch(() => undefined);
        await rotateInstallId({ storage, embedKey });
      })();
      // The `.catch`ed wrapper: a rejected `removeItem` must not be re-thrown
      // by every later `installId()` for the life of the process.
      rotation = rotating.catch(() => undefined);
      // Collected: throwing here would skip the clear and the subscribers.
      const errors: unknown[] = [];
      try {
        await rotating;
      } catch (err) {
        errors.push(err);
      } finally {
        rotation = undefined;
      }
      // Rotate, then clear; a swallowed `clear()` rejection leaves
      // `wasSignedIn` on an anonymous install. Subscribers fire regardless.
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

/** One runtime per `embedKey`, last configuration wins: a different
 *  `config.identity` reference swaps a fresh provider in place (reference
 *  equality, so an inline literal rebuilds every render), and the discarded one
 *  is never `clear()`ed — that drops `wasSignedIn`. `identity` is the only
 *  field reconciled: a new `config.storage` would strand the minted id. */
export const getRuntime = (config: MentioraConfig): MentioraRuntime => {
  const existing = runtimes.get(config.embedKey);
  if (existing) {
    if (existing.identityRef !== config.identity) {
      existing.runtime.identity = createIdentityProvider({
        identity: config.identity,
        embedKey: existing.embedKey,
        storage: existing.storage,
        // The entry's epoch, so a discarded provider's mint stays in scope.
        epoch: existing.epoch,
      });
      existing.identityRef = config.identity;
    }
    return existing.runtime;
  }
  const entry = buildEntry(config);
  runtimes.set(config.embedKey, entry);
  return entry.runtime;
};
