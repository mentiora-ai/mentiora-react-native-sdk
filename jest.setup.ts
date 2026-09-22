import AsyncStorage from '@react-native-async-storage/async-storage';
import { BackHandler, Linking } from 'react-native';

// The official in-memory mock; only the "./jest" subpath exists in this major.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest'),
);

afterEach(() => AsyncStorage.clear());

// BackHandler is not pre-mocked and its real iOS implementation is a no-op.
// Mutated in place: `jest.mock('react-native')` spreading requireActual would
// evaluate every lazy getter, including DevMenu, which throws.
Linking.openURL = jest.fn();
BackHandler.addEventListener = jest.fn(() => ({ remove: jest.fn() }));
