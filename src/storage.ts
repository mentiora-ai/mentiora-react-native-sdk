/**
 * Storage resolution for the install id (design.md §2.4).
 *
 * `@react-native-async-storage/async-storage` is an optional peer: a
 * consumer who never installed it must still get a working SDK, so the
 * production `load()` default wraps its `require` in a try/catch and falls
 * back to an in-memory `Map`. That fallback is `ephemeral: true` rather than
 * silently pretending to persist — losing the install id orphans every
 * thread the anonymous user created, so the caller warns (`__DEV__`) and
 * emits `onEvent` off this flag instead of staying quiet.
 *
 * The ESM build (`lib/module`, `"type": "module"`) has no synchronous
 * `require` at all — `resolveStorage` is synchronous and ESM has no
 * synchronous `require`, so no source-level trick makes that build
 * auto-resolve the peer. `defaultLoad` detects this explicitly (`typeof
 * require === 'function'`, which is a safe check even when `require` is
 * unbound — `typeof` never throws on an unbound identifier) rather than
 * letting a bare `require(...)` reference throw a `ReferenceError` that a
 * `catch {}` would silently swallow as "peer not installed". `reason`
 * carries which of those actually happened, so a caller (and a later
 * `__DEV__` warning) can tell "the peer genuinely isn't installed" apart
 * from "this build cannot auto-resolve storage at all — pass `storage`
 * explicitly on `MentioraConfig`".
 */
import type { MentioraStorage, StorageUnavailableReason } from './types.js';

export type { MentioraStorage, StorageUnavailableReason };

/** Internal and wider than the public `StorageUnavailableReason`: the two
 *  extra members are the cases where storage WORKS, which no event reports. */
export type StorageReason = 'override' | 'peer-loaded' | StorageUnavailableReason;

/**
 * Whether storage persists, and why. Discriminated on `ephemeral`, so a caller
 * that has checked it gets the narrow, public `StorageUnavailableReason` from
 * the compiler rather than from a cast — `reason` and `ephemeral` can then
 * never be made to disagree (re-review, N6).
 *
 * Written out rather than built with `Omit<ResolvedStorage, 'storage'>`:
 * `Omit` over a union collapses it into ONE member with both `reason` sets
 * unioned, which is precisely the correlation this type exists to keep.
 *
 * `detail` carries the underlying error's message, when there was one
 * ('no-require', a real require failure tagged 'peer-absent', or a custom
 * `load` throwing 'load-threw') — enough for a `__DEV__` diagnostic to say
 * exactly why, without leaking non-Error throw values verbatim.
 */
export type StorageStatus =
  | { ephemeral: false; reason: 'override' | 'peer-loaded'; detail?: string }
  | { ephemeral: true; reason: StorageUnavailableReason; detail?: string };

export type ResolvedStorage = { storage: MentioraStorage } & StorageStatus;

/** Tags *why* `defaultLoad` failed, so `resolveStorage`'s catch can tell
 *  "cannot even attempt a require" apart from "attempted, peer not there"
 *  apart from "attempted, and the peer itself blew up". */
class StorageLoadFailure extends Error {
  constructor(
    public readonly kind: 'no-require' | 'peer-absent' | 'load-threw',
    message: string,
  ) {
    super(message);
    this.name = 'StorageLoadFailure';
  }
}

/** For classifying a load failure, NOT for the `require` call itself. */
const ASYNC_STORAGE = '@react-native-async-storage/async-storage';

/**
 * `hasRequire` is an injectable seam (mirrors `random.ts`'s `globalCrypto`):
 * production uses its default, real `typeof require === 'function'` check;
 * tests pass `() => false` to simulate the ESM build without needing an
 * actual ESM loader.
 */
export const defaultLoad = (
  hasRequire: () => boolean = () => typeof require === 'function',
  // A second seam, for the same reason `loadSafeAreaInsets` has one: how a
  // failed require is CLASSIFIED (external review, m1) is not reachable
  // otherwise, because the real peer is installed in this repo and never
  // throws here. The specifier stays a literal inside the default — Metro
  // resolves `require` statically, so a computed one is unresolvable at bundle
  // time.
  requireModule: () => { default?: MentioraStorage } = () =>
    require('@react-native-async-storage/async-storage'),
): MentioraStorage | null => {
  if (!hasRequire()) {
    throw new StorageLoadFailure(
      'no-require',
      'require is not available in this module (the ESM build has no synchronous require, ' +
        'so it cannot auto-resolve the optional @react-native-async-storage/async-storage peer)',
    );
  }
  try {
    return requireModule().default ?? null;
  } catch (err) {
    // Only a MODULE_NOT_FOUND naming THIS package means the peer is absent
    // (external review, m1). Classifying every throw as `peer-absent` told a
    // customer to install a package they already have whenever async-storage
    // itself failed to initialise, or was missing a transitive dependency of
    // its own — and `peer-absent` is what the public `storageUnavailable`
    // event carries, so the wrong advice reaches the host app, not just a log.
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: unknown } | null)?.code;
    const absent = code === 'MODULE_NOT_FOUND' && message.includes(ASYNC_STORAGE);
    throw new StorageLoadFailure(absent ? 'peer-absent' : 'load-threw', message);
  }
};

const memoryStorage = (): MentioraStorage => {
  // ponytail: a plain Map is the whole store; no eviction, no TTL — this is
  // a per-call fallback, not a cache.
  const m = new Map<string, string>();
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => {
      m.set(k, v);
    },
    removeItem: async (k) => {
      m.delete(k);
    },
  };
};

export const resolveStorage = (
  override?: MentioraStorage,
  load: () => MentioraStorage | null = defaultLoad,
): ResolvedStorage => {
  if (override) return { storage: override, ephemeral: false, reason: 'override' };

  try {
    const loaded = load();
    if (loaded) return { storage: loaded, ephemeral: false, reason: 'peer-loaded' };
    return { storage: memoryStorage(), ephemeral: true, reason: 'peer-absent' };
  } catch (err) {
    const reason: StorageUnavailableReason =
      err instanceof StorageLoadFailure ? err.kind : 'load-threw';
    const detail = err instanceof Error ? err.message : String(err);
    return { storage: memoryStorage(), ephemeral: true, reason, detail };
  }
};
