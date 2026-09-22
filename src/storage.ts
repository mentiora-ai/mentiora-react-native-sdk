/**
 * Storage resolution for the install id. AsyncStorage is an optional peer, so
 * `defaultLoad` wraps its `require` and falls back to an in-memory `Map`
 * flagged `ephemeral: true` — losing the install id orphans the anonymous
 * user's threads. The ESM build has no synchronous `require` and cannot
 * auto-resolve the peer at all; `reason` tells the two apart.
 */
import type { MentioraStorage, StorageUnavailableReason } from './types.js';

export type { MentioraStorage, StorageUnavailableReason };

/** Wider than the public reason: the extra members mean storage WORKS. */
export type StorageReason = 'override' | 'peer-loaded' | StorageUnavailableReason;

/** Whether storage persists, and why. Discriminated on `ephemeral`, so a
 *  caller reads the narrow public reason without a cast; never `Omit<…>`. */
export type StorageStatus =
  | { ephemeral: false; reason: 'override' | 'peer-loaded'; detail?: string }
  | { ephemeral: true; reason: StorageUnavailableReason; detail?: string };

export type ResolvedStorage = { storage: MentioraStorage } & StorageStatus;

/** Tags *why* `defaultLoad` failed, for `resolveStorage`'s catch. */
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

/** `hasRequire` is a seam; `typeof` never throws on an unbound identifier. */
export const defaultLoad = (
  hasRequire: () => boolean = () => typeof require === 'function',
  // A second seam; the specifier stays a literal for Metro's static resolver.
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
    // `peer-absent` reaches the host as "install this package", so only a
    // MODULE_NOT_FOUND whose FIRST LINE names it qualifies: a transitive miss
    // lists this package in its Require stack and would misclassify.
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: unknown } | null)?.code;
    const absent =
      code === 'MODULE_NOT_FOUND' && (message.split('\n')[0] as string).includes(ASYNC_STORAGE);
    throw new StorageLoadFailure(absent ? 'peer-absent' : 'load-threw', message);
  }
};

const memoryStorage = (): MentioraStorage => {
  // ponytail: a plain Map, no eviction or TTL — a fallback, not a cache.
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
