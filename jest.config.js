module.exports = {
  preset: '@react-native/jest-preset',
  // Only .test.tsx: `node --test` owns .test.ts, and Jest would fail every one.
  testMatch: ['<rootDir>/src/**/*.test.tsx'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  // Sources import siblings with the `.js` the ESM build needs; Jest resolves .ts/.tsx.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-webview|@react-native-async-storage)/)',
  ],
  collectCoverageFrom: ['src/**/*.{ts,tsx}'], // never counts example/
};
