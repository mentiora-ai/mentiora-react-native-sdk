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
import type { MentioraStorage, StorageReason } from './types.js';

// `StorageReason` is declared in `types.ts` rather than here because it rides
// on the public `MentioraEvent` union (§2.4's `storageUnavailable`); this
// re-export keeps every internal caller importing it from the module that
// produces it.
export type { MentioraStorage, StorageReason };

export type ResolvedStorage = {
  storage: MentioraStorage;
  ephemeral: boolean;
  reason: StorageReason;
  /** The underlying error's message, when there was one ('no-require', a real
   *  require failure tagged 'peer-absent', or a custom `load` throwing
   *  'load-threw') — enough for a later `__DEV__` diagnostic to say exactly
   *  why, without leaking non-Error throw values verbatim. */
  detail?: string;
};

/** Tags *why* `defaultLoad` failed, so `resolveStorage`'s catch can tell
 *  "cannot even attempt a require" apart from "attempted, peer not there". */
class StorageLoadFailure extends Error {
  constructor(
    public readonly kind: 'no-require' | 'peer-absent',
    message: string,
  ) {
    super(message);
    this.name = 'StorageLoadFailure';
  }
}

/**
 * `hasRequire` is an injectable seam (mirrors `random.ts`'s `globalCrypto`):
 * production uses its default, real `typeof require === 'function'` check;
 * tests pass `() => false` to simulate the ESM build without needing an
 * actual ESM loader.
 */
export const defaultLoad = (
  hasRequire: () => boolean = () => typeof require === 'function',
): MentioraStorage | null => {
  if (!hasRequire()) {
    throw new StorageLoadFailure(
      'no-require',
      'require is not available in this module (the ESM build has no synchronous require, ' +
        'so it cannot auto-resolve the optional @react-native-async-storage/async-storage peer)',
    );
  }
  try {
    return require('@react-native-async-storage/async-storage').default;
  } catch (err) {
    throw new StorageLoadFailure('peer-absent', err instanceof Error ? err.message : String(err));
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
    const reason: StorageReason = err instanceof StorageLoadFailure ? err.kind : 'load-threw';
    const detail = err instanceof Error ? err.message : String(err);
    return { storage: memoryStorage(), ephemeral: true, reason, detail };
  }
};
