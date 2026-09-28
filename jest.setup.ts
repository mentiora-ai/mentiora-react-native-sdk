import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus, BackHandler, Linking } from 'react-native';

// The mock is plain CommonJS while the real package sets `exports.default`, which
// `defaultLoad` reads. Unwrapped, every test would see a spurious `peer-absent`.
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
}));

afterEach(() => AsyncStorage.clear());

// BackHandler is not pre-mocked and its real iOS implementation is a no-op.
// Mutated in place: `jest.mock('react-native')` spreading requireActual would
// evaluate every lazy getter, including DevMenu, which throws.
Linking.openURL = jest.fn();
// Dispatches like RN (newest first, stop at the first `true`); `remove()` must really
// unsubscribe or stale handlers answer presses.
const backHandlers: Array<() => boolean> = [];
(globalThis as unknown as { __backHandlers: Array<() => boolean> }).__backHandlers = backHandlers;
BackHandler.addEventListener = jest.fn((_event: string, handler: () => boolean) => {
  backHandlers.push(handler);
  return {
    remove: jest.fn(() => {
      const index = backHandlers.indexOf(handler);
      if (index >= 0) backHandlers.splice(index, 1);
    }),
  };
}) as unknown as typeof BackHandler.addEventListener;

// The preset's `AppState.currentState` is a `jest.fn()`, not a status, and its listener
// is never called. A real registry, so a test can background and foreground the app.
const appStateListeners = new Set<(state: AppStateStatus) => void>();
const appState = AppState as unknown as { currentState: AppStateStatus };
appState.currentState = 'active';
AppState.addEventListener = jest.fn((_type: string, handler: (s: AppStateStatus) => void) => {
  appStateListeners.add(handler);
  return { remove: jest.fn(() => appStateListeners.delete(handler)) };
}) as unknown as typeof AppState.addEventListener;
(globalThis as unknown as { __setAppState: (s: AppStateStatus) => void }).__setAppState = (s) => {
  appState.currentState = s;
  for (const fn of [...appStateListeners]) fn(s);
};
afterEach(() => {
  appState.currentState = 'active';
});
