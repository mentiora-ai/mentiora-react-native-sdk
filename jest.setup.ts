// Runs via setupFilesAfterEnv (merged with @react-native/jest-preset's own
// setupFiles), so afterEach and jest.fn() are available here.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BackHandler, Linking } from 'react-native';

// The official in-memory mock. The exports map declares only a "./jest" subpath;
// the "/jest/async-storage-mock" path some docs still show does not exist in this
// major version.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest'),
);

// The mock does not clear itself between tests.
afterEach(() => AsyncStorage.clear());

// Linking.openURL is already a jest.fn() via the preset; reassigned so the
// instance is owned here rather than by the preset's internals. BackHandler is
// not pre-mocked and its real iOS implementation is a no-op, so nothing can
// assert calls against it without this.
//
// Mutated in place rather than through `jest.mock('react-native', factory)`
// spreading `jest.requireActual('react-native')`: react-native's index.js exposes
// most of its surface as lazy getters, and `{...RN}` evaluates every one of them,
// including native-only ones like DevMenu, which throws under Jest
// ("TurboModuleRegistry.getEnforcing(...): 'DevMenu' could not be found").
// Importing only `Linking` and `BackHandler` triggers only their getters.
Linking.openURL = jest.fn();
BackHandler.addEventListener = jest.fn(() => ({ remove: jest.fn() }));
