/**
 * AsyncStorage is an optional peer; without it an in-memory `Map` is used, and losing
 * the install id orphans the anonymous user's threads. The ESM build cannot load the peer.
 */
import type { MentioraStorage, StorageUnavailableReason } from './types.js';

export type { MentioraStorage, StorageUnavailableReason };

export type StorageStatus =
  | { ephemeral: false; reason: 'override' | 'peer-loaded'; detail?: string }
  | { ephemeral: true; reason: StorageUnavailableReason; detail?: string };

export type ResolvedStorage = { storage: MentioraStorage } & StorageStatus;

class StorageLoadFailure extends Error {
  constructor(
    public readonly kind: StorageUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = 'StorageLoadFailure';
  }
}

const ASYNC_STORAGE = '@react-native-async-storage/async-storage';

export const defaultLoad = (
  hasRequire: () => boolean = () => typeof require === 'function',
  // The specifier must stay a literal for Metro's static resolver.
  requireModule: () => { default?: MentioraStorage } = () =>
    require('@react-native-async-storage/async-storage'),
): MentioraStorage | null => {
  if (!hasRequire()) {
    throw new StorageLoadFailure(
      'load-threw',
      'require is not available in this module (the ESM build has no synchronous require, ' +
        'so it cannot auto-resolve the optional @react-native-async-storage/async-storage peer)',
    );
  }
  try {
    return requireModule().default ?? null;
  } catch (err) {
    // Only the first line: a transitive miss also names the package, in the Require stack.
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: unknown } | null)?.code;
    const absent =
      code === 'MODULE_NOT_FOUND' && (message.split('\n')[0] as string).includes(ASYNC_STORAGE);
    throw new StorageLoadFailure(absent ? 'peer-absent' : 'load-threw', message);
  }
};

const memoryStorage = (): MentioraStorage => {
  // Plain Map with no eviction or TTL; it holds only a few keys.
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
