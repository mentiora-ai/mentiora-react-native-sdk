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
 */
import type { MentioraStorage } from './types.js';

export type { MentioraStorage };

export type ResolvedStorage = { storage: MentioraStorage; ephemeral: boolean };

const defaultLoad = (): MentioraStorage | null => {
  try {
    return require('@react-native-async-storage/async-storage').default;
  } catch {
    return null;
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
  if (override) return { storage: override, ephemeral: false };
  let loaded: MentioraStorage | null = null;
  try {
    loaded = load();
  } catch {
    loaded = null;
  }
  if (loaded) return { storage: loaded, ephemeral: false };
  return { storage: memoryStorage(), ephemeral: true };
};
