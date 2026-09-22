/**
 * The shared runtime, one per embed key.
 *
 * Two entry points can be live at once — a mounted `<MentioraWidget />` and a
 * `Mentiora.open()` Modal — and each gets its own WebView, peer and session
 * key, which are per page load by definition. Storage, the install id and the
 * identity provider are not: they are per-`embedKey` process state. Without
 * sharing them, a first anonymous launch with two mounted widgets has each one
 * read a missing install id, mint its own and write the same storage key — two
 * different anonymous users until one surface reloads onto whichever id won.
 *
 * No per-load state belongs here: a peer, a session key or a WebView reference
 * in this module is the presentation layer leaking in.
 */
import { createIdentityProvider, type IdentityProvider, type LogoutEpoch } from './identity.js';
import { loadOrCreateInstallId, rotateInstallId } from './install-id.js';
import { resolveStorage, type StorageStatus } from './storage.js';
import type { MentioraConfig, MentioraIdentity, MentioraStorage } from './types.js';

/** 16 random bytes, from the WebView that is asking. */
export type RandomBytes = (n: number) => Promise<Uint8Array>;

export type MentioraRuntime = {
  /** Single-flight, and it takes the CALLER's random source rather than one
   *  captured when the runtime was built (see `installId` below). */
  installId: (randomBytes: RandomBytes) => Promise<string>;
  identity: IdentityProvider;
  /** `resolveStorage`'s result minus the store itself. `reason` rides along
   *  with the boolean so the composition root's __DEV__ warning can say "this
   *  build cannot auto-resolve storage, pass config.storage" rather than
   *  naming the wrong cause. Discriminated like `ResolvedStorage`, so the
   *  composition root gets the narrow, public `StorageUnavailableReason` from
   *  the `ephemeral` check it already makes rather than from a cast. */
  storage: StorageStatus;
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
  /** One logout epoch for every provider this entry ever owns. `logout()` can
   *  only `clear()` the provider live at its start and the one live at its
   *  end; a provider `getRuntime` discarded before the logout is unreachable
   *  from here, yet its mint may still be parked in `fetch`. The shared epoch
   *  makes that mint see the logout instead of resuming and writing the
   *  `wasSignedIn` marker onto a logged-out install, which deadlocks every
   *  later boot on `IdentityUnavailable`. */
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

  // Single-flight over the IN-FLIGHT PROMISE, not the resolved value:
  // memoising the resolved value lets two concurrent first callers each mint
  // an id.
  //
  // `randomBytes` is a parameter rather than captured here. Random bytes come
  // from a WebView, which belongs to one mounted widget, while this runtime is
  // shared by every widget on the embed key — so a captured source is the
  // first widget's forever, and widget B's mint would inject into widget A's
  // page, rejected while A's own request is outstanding (`random.ts` allows
  // one in flight) or lost once A unmounts. Taking it per call means the
  // caller that triggers the mint uses its own live page.
  let inFlight: Promise<string> | undefined;
  // Set for the duration of a `logout()`'s rotation and awaited by every new
  // mint. Dropping the memo alone leaves a window between "the memo is gone"
  // and "`removeItem` has landed": a call arriving there reads storage before
  // the rotation and both returns AND re-memoises the previous user's id.
  let rotation: Promise<void> | undefined;
  const installId = (randomBytes: RandomBytes): Promise<string> => {
    if (!inFlight) {
      const pendingRotation = rotation;
      // `if (inFlight === p)`, never an unconditional null. `logout()` drops
      // the memo itself and the prior mint can settle long after a post-logout
      // caller has installed a NEW one; clearing unconditionally erases that
      // newer memo, and the next two callers each mint — two surfaces on two
      // different anonymous users.
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

  // `logout` reads `runtime.identity` live rather than closing over a local
  // const, which is what lets `getRuntime` swap the provider out from under an
  // already-built runtime (the last `configure()` wins) without `logout`
  // clearing the wrong one.
  const runtime: MentioraRuntime = {
    installId,
    identity: createIdentityProvider({ identity: config.identity, embedKey, storage, epoch }),
    // Rebuilt per branch rather than field by field: one object literal over
    // the union widens `ephemeral` to `boolean` and `reason` to the internal
    // `StorageReason`, losing the correlation the type exists to keep.
    storage: resolved.ephemeral
      ? { ephemeral: true, reason: resolved.reason, detail: resolved.detail }
      : { ephemeral: false, reason: resolved.reason },
    onReload,
    logout: async () => {
      // Captured before the first await: `getRuntime` can swap
      // `runtime.identity` out mid-rotation, and reading it only at the end
      // leaves the provider that was actually minting during the logout
      // outside it, free to write its token and the `wasSignedIn` marker back
      // afterwards. The one live at the end is cleared too, below.
      const clearing = runtime.identity;
      // Drop the memo, park every new mint behind the rotation, and let the
      // prior mint SETTLE before the delete. `rotation` is assigned before the
      // first await, so it is visible as soon as `logout()` returns. A mint
      // blocked in `storage.setItem` would otherwise commit after
      // `removeItem` and the pre-logout id would survive its own rotation.
      // Settle, not succeed: a rejected mint can no longer race. Nothing
      // bounds the wait, which is the correct direction — deleting while a
      // write is live is the failure.
      const prior = inFlight;
      inFlight = undefined;
      const rotating = (async () => {
        await prior?.catch(() => undefined);
        await rotateInstallId({ storage, embedKey });
      })();
      // Mints park on this `.catch`ed wrapper, not on `rotating` itself: they
      // wait for the rotation without inheriting its failure. A `removeItem`
      // that rejects would otherwise leave `rotation` a rejected promise that
      // every later `installId()` re-throws for the life of the process —
      // through the initialize handler's catch, an error screen no user can
      // get past.
      rotation = rotating.catch(() => undefined);
      // Collected, not thrown: propagating a `removeItem` rejection straight
      // out skips the identity clear and every reload subscriber, leaving the
      // token and the live session alive after the install id was dropped. The
      // first error still reaches the caller, at the very end.
      const errors: unknown[] = [];
      try {
        await rotating;
      } catch (err) {
        errors.push(err);
      } finally {
        rotation = undefined;
      }
      // Rotate first, then clear, and let a `clear()` rejection reach the
      // caller: swallowed, it leaves the wasSignedIn flag set on a
      // now-anonymous install, a boot deadlock per `initial()` in identity.ts.
      // Subscribers are notified on the way out whatever happens — the
      // rotation has already landed, so skipping the reload would leave the
      // mounted WebView running on a pre-logout token with no install id in
      // storage.
      try {
        await clearing.clear();
        // A provider swapped in mid-logout (`getRuntime`, last config wins) is
        // inside this logout too: a widget reading `runtime.identity` live may
        // already have asked it for a token.
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

/** One runtime per `embedKey`, and the last configuration wins: a later
 *  `getRuntime` whose `config.identity` is a different reference swaps a fresh
 *  provider into the existing runtime, in place. Storage, the install-id memo
 *  and the `onReload` subscribers survive, none of them depending on the
 *  identity source. Reference equality only, so a caller passing a fresh
 *  object literal every render rebuilds the provider every render.
 *
 *  The discarded provider is never told to `clear()`, which would also drop
 *  the `wasSignedIn` flag and let the very next boot demote a signed-in
 *  install to a fresh anonymous one. Discarding the object is enough; its
 *  cached token dies with it.
 *
 *  `identity` is the ONLY field reconciled. A different `config.storage` on a
 *  repeat call is ignored, since swapping storage mid-life strands the install
 *  id the runtime already minted in the old store, so `MentioraRuntime.storage`
 *  is a build-time snapshot and stays accurate only while that holds. */
export const getRuntime = (config: MentioraConfig): MentioraRuntime => {
  const existing = runtimes.get(config.embedKey);
  if (existing) {
    if (existing.identityRef !== config.identity) {
      existing.runtime.identity = createIdentityProvider({
        identity: config.identity,
        embedKey: existing.embedKey,
        storage: existing.storage,
        // The entry's epoch, never a fresh one: the provider being discarded
        // here may have a mint in flight that must stay inside any later
        // logout.
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
