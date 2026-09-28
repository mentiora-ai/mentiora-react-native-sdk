module.exports = {
  preset: '@react-native/jest-preset',
  testMatch: ['<rootDir>/src/**/*.test.{ts,tsx}'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  // Sources import siblings with the `.js` the ESM build needs; Jest resolves .ts/.tsx.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^node:test$': '<rootDir>/jest.node-test.js',
  },
  // bun stores packages under `node_modules/.bun/<pkg>/node_modules/<name>/`; without the
  // `\\.bun/` exception the first `node_modules/` match excludes them from transformation.
  transformIgnorePatterns: [
    'node_modules/(?!\\.bun/|((jest-)?react-native|@react-native(-community)?|react-native-webview|@react-native-async-storage)/)',
  ],
  collectCoverageFrom: ['src/**/*.{ts,tsx}'], // never counts example/
};
