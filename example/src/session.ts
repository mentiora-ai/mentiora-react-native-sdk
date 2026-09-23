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

/**
 * A page that fails after the handshake shows a full-screen error with no close control,
 * and the overlay covers the app. Close it if `ready` has not arrived by the deadline.
 *
 * Only armed while no page has ever reported `ready`. The widget is kept warm now, so a
 * reopen reveals a live document and no second `ready` is coming — arming then would fire
 * on a perfectly healthy widget and close it out from under the user.
 */
const BOOT_DEADLINE_MS = 12_000;
let bootTimer: ReturnType<typeof setTimeout> | undefined;
let everReady = false;

export const armBootDeadline = (onExpiry: () => void): void => {
  clearTimeout(bootTimer);
  if (everReady) {
    bootTimer = undefined;
    return;
  }
  bootTimer = setTimeout(onExpiry, BOOT_DEADLINE_MS);
};

export const disarmBootDeadline = (ready = false): void => {
  if (ready) everReady = true;
  clearTimeout(bootTimer);
  bootTimer = undefined;
};
