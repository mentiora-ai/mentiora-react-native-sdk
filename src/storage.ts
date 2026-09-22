/**
 * Storage resolution for the install id.
 *
 * `@react-native-async-storage/async-storage` is an optional peer, so the
 * production `load()` wraps its `require` in a try/catch and falls back to an
 * in-memory `Map`. The fallback is `ephemeral: true` rather than silently
 * pretending to persist: losing the install id orphans every thread the
 * anonymous user created, so the caller warns under `__DEV__` and emits
 * `onEvent` off the flag.
 *
 * The ESM build (`lib/module`, `"type": "module"`) has no synchronous
 * `require` and `resolveStorage` is synchronous, so that build cannot
 * auto-resolve the peer at all. `defaultLoad` detects it with `typeof
 * require === 'function'` — `typeof` never throws on an unbound identifier —
 * rather than letting a bare `require(...)` throw a `ReferenceError` that a
 * `catch {}` would read as "peer not installed". `reason` distinguishes the
 * two, so a caller can say "install the peer" or "pass `storage` explicitly
 * on `MentioraConfig`" rather than the wrong one.
 */
import type { MentioraStorage, StorageUnavailableReason } from './types.js';

export type { MentioraStorage, StorageUnavailableReason };

/** Internal and wider than the public `StorageUnavailableReason`: the two
 *  extra members are the cases where storage WORKS, which no event reports. */
export type StorageReason = 'override' | 'peer-loaded' | StorageUnavailableReason;

/**
 * Whether storage persists, and why. Discriminated on `ephemeral`, so a caller
 * that has checked it gets the narrow, public `StorageUnavailableReason` from
 * the compiler rather than from a cast. Written out rather than
 * `Omit<ResolvedStorage, 'storage'>`, which collapses the union into one
 * member with both `reason` sets merged and loses that correlation. `detail`
 * carries the underlying error's message when there was one.
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
 * `hasRequire` is an injectable seam (mirroring `random.ts`'s `globalCrypto`):
 * production uses the real `typeof require === 'function'` check, tests pass
 * `() => false` to simulate the ESM build without an ESM loader.
 */
export const defaultLoad = (
  hasRequire: () => boolean = () => typeof require === 'function',
  // A second seam: the real peer is installed in this repo and never throws,
  // so how a failed require is classified is otherwise unreachable. The
  // specifier stays a literal inside the default, because Metro resolves
  // `require` statically and cannot resolve a computed one at bundle time.
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
    // `peer-absent` rides out on the public `storageUnavailable` event, so a
    // misclassification tells the host app to install a package it already
    // has. Only a MODULE_NOT_FOUND whose FIRST LINE names this package
    // qualifies: Node's message for a transitive miss is `Cannot find module
    // 'x'\nRequire stack:\n- …/async-storage/index.js\n- …`, so matching the
    // whole message finds the peer that IS installed and reports it absent.
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: unknown } | null)?.code;
    const absent =
      code === 'MODULE_NOT_FOUND' && (message.split('\n')[0] as string).includes(ASYNC_STORAGE);
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
