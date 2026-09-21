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
import type { MentioraConfig, MentioraIdentity, MentioraStorage } from './types.js';

/** 16 random bytes, from the WebView that is asking. */
export type RandomBytes = (n: number) => Promise<Uint8Array>;

export type MentioraRuntime = {
  /** Single-flight, and it takes the CALLER's random source rather than one
   *  captured when the runtime was built (see `installId` below). */
  installId: (randomBytes: RandomBytes) => Promise<string>;
  identity: IdentityProvider;
  /** From Task 6's `resolveStorage`. `reason` is carried, not just the boolean: the
   *  composition root's __DEV__ warning must be able to say "this build cannot
   *  auto-resolve storage, pass config.storage" rather than naming the wrong cause. */
  storage: { ephemeral: boolean; reason: StorageReason; detail?: string };
  logout: () => Promise<void>; // rotate + clear identity; reloads are the caller's job
  onReload: (fn: () => void) => () => void; // mounted widgets subscribe
};

/** Bookkeeping kept alongside the runtime so `getRuntime` can decide, on a
 *  later call for the same `embedKey`, whether `identity` needs swapping —
 *  without re-resolving storage or rebuilding the install-id memo. */
type RuntimeEntry = {
  runtime: MentioraRuntime;
  storage: MentioraStorage;
  embedKey: string;
  /** The `config.identity` reference the live provider was built from. */
  identityRef: MentioraIdentity | undefined;
};

const runtimes = new Map<string, RuntimeEntry>();

/** Tests only. Clears every cached runtime so each test starts from nothing. */
export const __resetRuntimes = (): void => {
  runtimes.clear();
};

const buildEntry = (config: MentioraConfig): RuntimeEntry => {
  const { embedKey } = config;
  const resolved = resolveStorage(config.storage);
  const { storage } = resolved;

  // Single-flight: memoise the IN-FLIGHT PROMISE, not the resolved value.
  // Memoising only the value still lets two concurrent first callers race
  // past the "is there one already" check before either has written one.
  //
  // `randomBytes` is a PARAMETER, not something captured here. Random bytes
  // come from a WebView (design.md §2.1) and a WebView belongs to one mounted
  // widget, while this runtime is shared by every widget on the embed key
  // (§2.4) — so a source captured at build time is the FIRST widget's source
  // forever. With two widgets and a first launch, widget B's mint would inject
  // into widget A's page: rejected outright while A's own session-key request
  // is still outstanding (`random.ts`, one request in flight at a time), or
  // simply lost once A has unmounted. The install id is single-flight, so that
  // one failure fails both handshakes. Taking the source per call means the
  // caller that triggers the mint always uses its own live page, and a
  // concurrent caller piggybacks on that promise rather than opening a second
  // request on anyone's source.
  let inFlight: Promise<string> | undefined;
  // Set for the duration of a `logout()`'s rotation, and awaited by every new
  // mint. Dropping the memo alone (what `logout` used to do) leaves a window
  // between "the memo is gone" and "`removeItem` has landed": a call arriving
  // there misses the memo, reads storage before the rotation, and both returns
  // AND re-memoises the PRE-rotation id — the previous user's, handed to the
  // next one, which is the exact thing dropping the memo was for (branch
  // review, m5). `await undefined` is a no-op, so the normal path pays a
  // microtask and nothing else.
  let rotation: Promise<void> | undefined;
  const installId = (randomBytes: RandomBytes): Promise<string> => {
    if (!inFlight) {
      const pendingRotation = rotation;
      inFlight = (async () => {
        await pendingRotation;
        return await loadOrCreateInstallId({ storage, embedKey, randomBytes });
      })().finally(() => {
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

  // `runtime` is referenced from inside `logout`, below, before this object
  // literal finishes evaluating. That's fine: `logout` only reads
  // `runtime.identity` when it's later called, by which point `runtime` is
  // fully assigned — and reading it live (rather than closing over a local
  // `identity` const) is what lets `getRuntime` swap the provider out from
  // under an already-built runtime (design.md:270-272, "the last
  // `configure()` wins") without `logout` ever clearing the wrong one.
  const runtime: MentioraRuntime = {
    installId,
    identity: createIdentityProvider({ identity: config.identity, embedKey, storage }),
    storage: { ephemeral: resolved.ephemeral, reason: resolved.reason, detail: resolved.detail },
    onReload,
    logout: async () => {
      // Drop the memo AND park every new mint behind the rotation: a caller
      // awaiting the *old* in-flight promise still gets what was already
      // committed (the pre-rotation id — it already read from storage), while
      // every NEW installId() call from this point on waits for the rotation
      // to land before it reads storage. `rotation` is assigned before the
      // first await, so it is already visible to anything that calls
      // `installId()` after `logout()` returns its promise.
      inFlight = undefined;
      const rotating = rotateInstallId({ storage, embedKey });
      // What mints park on is deliberately NOT `rotating` itself. They need to
      // wait for the rotation to finish; they must not inherit its failure. A
      // `removeItem` that rejects (a full or corrupt SQLite file under
      // AsyncStorage, or anything a customer `storage` override does) would
      // otherwise leave `rotation` pointing at a rejected promise that every
      // later `installId()` re-throws — for the life of the process, long
      // after the disk recovered, and through the initialize handler's catch
      // that is an error screen the user cannot get past.
      //
      // The `.catch` is the line that fixes it; the `finally` is redundant
      // given it (a permanently-resolved `rotation` costs a microtask per
      // mint and nothing else) and no test can distinguish the two. It stays
      // because releasing the slot on the failing path is what keeps the
      // `.catch` from being load-bearing on its own.
      rotation = rotating.catch(() => undefined);
      try {
        await rotating;
      } finally {
        rotation = undefined;
      }
      // clear() rejects if the wasSignedIn flag removal fails. Rotate first,
      // then clear: if clear() throws, the install id is already anonymous
      // (rotated), so the flag is the only thing left inconsistent, and the
      // rejection must reach the caller rather than being swallowed — a
      // swallowed failure here would leave the flag set on a now-anonymous
      // install, which is a boot deadlock per identity.ts's `initial()`.
      await runtime.identity.clear();
      for (const fn of subscribers) fn();
    },
  };

  return { runtime, storage, embedKey, identityRef: config.identity };
};

/** One runtime per `embedKey`. The map is keyed on `embedKey` alone — two
 *  call sites (`Mentiora.configure()` and `<MentioraWidget />`) can pass the
 *  same embed key with a different `identity`, and per design.md:270-272
 *  "the last `configure()` wins for the runtime": a later `getRuntime` call
 *  whose `config.identity` is a different reference swaps in a fresh
 *  identity provider for the *existing* runtime, in place. Everything else —
 *  storage, the install-id memo, the `onReload` subscribers — survives,
 *  because none of it depends on which identity source is configured.
 *
 *  Reference equality only: a caller passing a fresh object literal every
 *  render pays for a rebuilt provider every render. That's the documented
 *  cost of `identity` being a prop, not a bug to soften with a deep compare.
 *
 *  The discarded provider is never told to `clear()` — that would also drop
 *  the `wasSignedIn` flag from storage, and swapping identity source is not
 *  a logout: doing so would let the very next boot demote a signed-in
 *  install to a fresh anonymous one. Discarding the object is enough; its
 *  cached token dies with it.
 *
 *  `identity` is the ONLY field reconciled. A repeat call passing a different
 *  `config.storage` is ignored on purpose: storage is per-embed-key ownership
 *  (design.md:262-269), swapping it mid-life would strand the install id the
 *  runtime already minted into the old store, and no caller has a reason to.
 *  `MentioraRuntime.storage` is therefore a build-time snapshot and stays
 *  accurate only while that holds — relax this and it goes stale. */
export const getRuntime = (config: MentioraConfig): MentioraRuntime => {
  const existing = runtimes.get(config.embedKey);
  if (existing) {
    if (existing.identityRef !== config.identity) {
      existing.runtime.identity = createIdentityProvider({
        identity: config.identity,
        embedKey: existing.embedKey,
        storage: existing.storage,
      });
      existing.identityRef = config.identity;
    }
    return existing.runtime;
  }
  const entry = buildEntry(config);
  runtimes.set(config.embedKey, entry);
  return entry.runtime;
};
