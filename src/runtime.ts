/**
 * The shared runtime, one per embed key (design.md §2.4).
 *
 * Two entry points can be live at once — a mounted `<MentioraWidget />` and a
 * `Mentiora.open()` Modal — and each gets its own WebView, its own peer and
 * its own session key, because those are per page load by definition. But
 * storage, the install id and the identity provider are not: they are
 * per-`embedKey` process state. Without sharing them, a first anonymous
 * launch with two mounted widgets would have each one read a missing install
 * id, mint its own, and both write the same storage key — two different
 * anonymous users until one surface reloads onto whichever id won the race.
 *
 * This module owns none of the per-load state. If it grows a peer, a session
 * key or a WebView reference, that's Task 11a's job leaking in here.
 */
import { createIdentityProvider, type IdentityProvider } from './identity.js';
import { loadOrCreateInstallId, rotateInstallId } from './install-id.js';
import { resolveStorage, type StorageReason } from './storage.js';
import type { MentioraConfig } from './types.js';

export type MentioraRuntime = {
  installId: () => Promise<string>; // single-flight
  identity: IdentityProvider;
  /** From Task 6's `resolveStorage`. `reason` is carried, not just the boolean: the
   *  composition root's __DEV__ warning must be able to say "this build cannot
   *  auto-resolve storage, pass config.storage" rather than naming the wrong cause. */
  storage: { ephemeral: boolean; reason: StorageReason; detail?: string };
  logout: () => Promise<void>; // rotate + clear identity; reloads are the caller's job
  onReload: (fn: () => void) => () => void; // mounted widgets subscribe
};

const runtimes = new Map<string, MentioraRuntime>();

/** Tests only. Clears every cached runtime so each test starts from nothing. */
export const __resetRuntimes = (): void => {
  runtimes.clear();
};

const buildRuntime = (
  config: MentioraConfig,
  randomBytes: (n: number) => Promise<Uint8Array>,
): MentioraRuntime => {
  const { embedKey } = config;
  const resolved = resolveStorage(config.storage);
  const { storage } = resolved;

  const identity = createIdentityProvider({
    identity: config.identity,
    embedKey,
    storage,
  });

  // Single-flight: memoise the IN-FLIGHT PROMISE, not the resolved value.
  // Memoising only the value still lets two concurrent first callers race
  // past the "is there one already" check before either has written one.
  let inFlight: Promise<string> | undefined;
  const installId = (): Promise<string> => {
    if (!inFlight) {
      inFlight = loadOrCreateInstallId({ storage, embedKey, randomBytes }).finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  };

  const subscribers = new Set<() => void>();
  const onReload = (fn: () => void): (() => void) => {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  };

  const logout = async (): Promise<void> => {
    // Drop the memo first: an installId() in flight when logout runs must
    // not resolve to the pre-rotation id once logout has finished. Clearing
    // the memo before rotating means any caller awaiting the *old* in-flight
    // promise still gets what was already committed (the pre-rotation id —
    // it already read from storage), but every NEW installId() call after
    // this point misses the memo and reads storage fresh, past the rotation.
    inFlight = undefined;
    await rotateInstallId({ storage, embedKey });
    // clear() rejects if the wasSignedIn flag removal fails. Rotate first,
    // then clear: if clear() throws, the install id is already anonymous
    // (rotated), so the flag is the only thing left inconsistent, and the
    // rejection must reach the caller rather than being swallowed — a
    // swallowed failure here would leave the flag set on a now-anonymous
    // install, which is a boot deadlock per identity.ts's `initial()`.
    await identity.clear();
    for (const fn of subscribers) fn();
  };

  return {
    installId,
    identity,
    storage: { ephemeral: resolved.ephemeral, reason: resolved.reason, detail: resolved.detail },
    logout,
    onReload,
  };
};

/** One runtime per `embedKey`. The map is keyed on `embedKey` alone — two
 *  call sites can pass the same embed key with a different `identity`, and
 *  the last one to call `getRuntime` wins. Keying on the whole config would
 *  defeat the sharing this exists for. */
export const getRuntime = (
  config: MentioraConfig,
  randomBytes: (n: number) => Promise<Uint8Array>,
): MentioraRuntime => {
  const existing = runtimes.get(config.embedKey);
  if (existing) return existing;
  const runtime = buildRuntime(config, randomBytes);
  runtimes.set(config.embedKey, runtime);
  return runtime;
};
