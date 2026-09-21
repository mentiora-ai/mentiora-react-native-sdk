// Runs via setupFilesAfterEnv (merged with @react-native/jest-preset's own
// setupFiles), so afterEach and jest.fn() are available here.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BackHandler, Linking } from 'react-native';

// The package's exports map only declares a "./jest" subpath (not the older
// "/jest/async-storage-mock" file some docs still reference — that path does
// not exist in this major version). This is the official in-memory mock.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest'),
);

// The mock does not clear itself between tests.
afterEach(() => AsyncStorage.clear());

// Linking.openURL is already a jest.fn() via the preset's own Linking mock;
// reassigned here anyway so ownership of the instance is explicit and not an
// accident of the preset's internals. BackHandler is not pre-mocked: its
// real (iOS) implementation is a plain no-op, so Tasks 11/12 cannot assert
// calls against it without this.
//
// Mutated in place rather than via `jest.mock('react-native', factory)`
// spreading `jest.requireActual('react-native')`: react-native's index.js
// exposes most of its surface as lazy getters (module registry -> real
// native module), and `{...RN}` enumerates and evaluates every one of them
// eagerly, including native-only ones like DevMenu, which then throws
// ("TurboModuleRegistry.getEnforcing(...): 'DevMenu' could not be found")
// since no native binary exists under Jest. Importing just `Linking` and
// `BackHandler` triggers only their own getters.
Linking.openURL = jest.fn();
BackHandler.addEventListener = jest.fn(() => ({ remove: jest.fn() }));
