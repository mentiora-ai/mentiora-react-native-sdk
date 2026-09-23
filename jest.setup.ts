import AsyncStorage from '@react-native-async-storage/async-storage';
import { BackHandler, Linking } from 'react-native';

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
// A real registry, so a test can dispatch back the way RN does — newest subscriber
// first, stopping at the first `true` — and so an unmounted component's handler really
// goes away. Returning a dead `remove()` would leave stale handlers answering presses.
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
