module.exports = {
  preset: '@react-native/jest-preset',
  // Only .test.tsx. scripts/run-core-tests.mjs owns every .test.ts via `node --test`;
  // Jest's default testMatch would also pick those up, find no Jest-registered tests
  // in them (they call `test` from `node:test`) and fail every one.
  testMatch: ['<rootDir>/src/**/*.test.tsx'],
  // afterEach in jest.setup.ts needs the test framework installed, which only
  // setupFilesAfterEnv guarantees (setupFiles runs before it exists).
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  // Sources import siblings with the `.js` extension TypeScript's ESM output needs
  // (`lib/module` is `type: module`). Jest resolves against the .ts/.tsx sources, so
  // the extension has to be mapped back off.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-webview|@react-native-async-storage)/)',
  ],
  collectCoverageFrom: ['src/**/*.{ts,tsx}'], // never counts example/
};
