import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

// On `globalThis` so it survives screen remounts and Fast Refresh.
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

/** The SDK refuses an anonymous boot on a signed-in install until `Mentiora.logout()`,
 *  so sign-in must persist across launches. */
const SIGNED_IN_KEY = 'example.signedInUser';
type SignedIn = { sub: string; name: string };

export const rememberSignIn = (user: SignedIn): Promise<void> =>
  AsyncStorage.setItem(SIGNED_IN_KEY, JSON.stringify(user));

export const forgetSignIn = (): Promise<void> => AsyncStorage.removeItem(SIGNED_IN_KEY);

export const recallSignIn = async (): Promise<SignedIn | null> => {
  const raw = await AsyncStorage.getItem(SIGNED_IN_KEY);
  return raw === null ? null : (JSON.parse(raw) as SignedIn);
};
