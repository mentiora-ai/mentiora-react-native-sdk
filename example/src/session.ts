import { useSyncExternalStore } from 'react';

// Not component state: the home screen remounts when the Modal presents over it. On
// `globalThis` so Fast Refresh re-evaluating this module does not reset it.
type Store = { principal: string; launched: boolean };
const KEY = '__mentioraExampleSession';
const g = globalThis as typeof globalThis & { [KEY]?: Store };
g[KEY] ??= { principal: 'anonymous', launched: false };
const store: Store = g[KEY];
const listeners = new Set<() => void>();

export const setPrincipal = (next: string): void => {
  store.principal = next;
  for (const listener of listeners) listener();
};

/** True exactly once per app launch, so the widget opens on start and not on remount. */
export const claimLaunch = (): boolean => {
  if (store.launched) return false;
  store.launched = true;
  return true;
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const usePrincipal = (): string => useSyncExternalStore(subscribe, () => store.principal);

// A page that fails after the handshake shows a full-screen error with no close control,
// and the Modal covers the app. Close it if `ready` has not arrived by the deadline.
const BOOT_DEADLINE_MS = 12_000;
let bootTimer: ReturnType<typeof setTimeout> | undefined;

export const armBootDeadline = (onExpiry: () => void): void => {
  clearTimeout(bootTimer);
  bootTimer = setTimeout(onExpiry, BOOT_DEADLINE_MS);
};

export const disarmBootDeadline = (): void => {
  clearTimeout(bootTimer);
  bootTimer = undefined;
};
