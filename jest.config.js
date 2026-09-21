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
  // Every source file imports its siblings with the `.js` extension TypeScript's
  // ESM output requires — `lib/module` is `type: module`, where an extensionless
  // specifier does not resolve. Jest resolves against the .ts/.tsx sources, so it
  // needs the extension mapped back off.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-webview|@react-native-async-storage)/)',
  ],
  collectCoverageFrom: ['src/**/*.{ts,tsx}'], // never counts example/
};
