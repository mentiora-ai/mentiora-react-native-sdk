module.exports = {
  preset: '@react-native/jest-preset',
  // Only .test.tsx: `node --test` owns .test.ts, and Jest would fail every one.
  testMatch: ['<rootDir>/src/**/*.test.tsx'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  // Sources import siblings with the `.js` the ESM build needs; Jest resolves .ts/.tsx.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // bun stores packages under `node_modules/.bun/<pkg>/node_modules/<name>/`; without the
  // `\\.bun/` exception the first `node_modules/` match excludes them from transformation.
  transformIgnorePatterns: [
    'node_modules/(?!\\.bun/|((jest-)?react-native|@react-native(-community)?|react-native-webview|@react-native-async-storage)/)',
  ],
  collectCoverageFrom: ['src/**/*.{ts,tsx}'], // never counts example/
};
