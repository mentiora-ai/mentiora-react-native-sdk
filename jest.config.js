module.exports = {
  preset: '@react-native/jest-preset',
  // Only .test.tsx: the core runner (scripts/run-core-tests.mjs) already owns every
  // .test.ts file via `node --test`. Jest's own default testMatch also matches
  // .test.ts anywhere in the tree, which would make it pick up those same 108 core
  // tests, find zero Jest-registered tests in each (they call `test` from
  // `node:test`, not Jest's global), and fail every one of them.
  testMatch: ['<rootDir>/src/**/*.test.tsx'],
  // afterEach in jest.setup.ts needs the test framework installed, which only
  // setupFilesAfterEnv guarantees (setupFiles runs before it exists).
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-webview|@react-native-async-storage)/)',
  ],
  collectCoverageFrom: ['src/**/*.{ts,tsx}'], // never counts example/
};
