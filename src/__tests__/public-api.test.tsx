// Named `.tsx`, not the `.ts` the brief wrote: `jest.config.js` matches only
// `src/**/*.test.tsx`, and `tsconfig.test.json` excludes `src/__tests__`, so a
// `.ts` file here would be compiled by nothing and run by nothing — a suite
// that silently never executes. The extension is the only thing that makes
// these assertions run.

import type { MentioraEvent } from '../index';
import * as sdk from '../index';

// `expect(typeof sdk.MentioraWidget).toBe('function')` is NOT a test: the scaffold stub
// is a function too, and so is every wrong implementation. Assert the stub is gone by
// its observable behaviour — calling it.
test('the stubs are gone: the surface no longer throws "not implemented"', () => {
  expect(() => sdk.Mentiora.close()).not.toThrow();
  expect(() =>
    sdk.Mentiora.configure({ widgetOrigin: 'https://w.x.ai', embedKey: 'pk_wgt_a' }),
  ).not.toThrow();
});

test('SDK_VERSION matches package.json — release.yml aborts if it does not', () => {
  const pkg = require('../../package.json') as { version: string };
  expect(sdk.SDK_VERSION).toBe(pkg.version);
  expect(sdk.SDK_NAME).toBe('@mentiora/react-native-sdk');
});

test('the surface is exactly the approved list — no internals, no test helpers', () => {
  // Types erase at runtime, so this covers the value exports only. The type list is
  // checked from outside the package by ci.yml's check.ts.
  expect(Object.keys(sdk).sort()).toEqual(
    ['Mentiora', 'MentioraHost', 'MentioraWidget', 'SDK_NAME', 'SDK_VERSION'].sort(),
  );
});

test('the internal test helpers are not reachable through the public entry', () => {
  // All four would ship under `export *`. Named exports are what keeps them out.
  expect(Object.keys(sdk).some((k) => k.startsWith('__'))).toBe(false);
  const surface = sdk as unknown as Record<string, unknown>;
  expect(surface.__resetPresenter).toBeUndefined();
  expect(surface.__resolveHostInsetsForTest).toBeUndefined();
  expect(surface.DEFAULT_STRINGS).toBeUndefined();
});

test('Mentiora carries exactly the four documented methods', () => {
  expect(Object.keys(sdk.Mentiora).sort()).toEqual(['close', 'configure', 'logout', 'open'].sort());
});

// Re-review, N6. `storageUnavailable`'s `reason` must stay NARROWER than the
// internal `StorageReason`: `'override'` and `'peer-loaded'` both mean storage
// works, so neither can ever accompany the event, and carrying them on a
// versioned union would hand every consumer two switch arms that are dead by
// construction. This is a compile-time assertion — it is enforced by `bun run
// typecheck`, which covers `src/__tests__`, and the `@ts-expect-error` below
// fails the build the moment someone widens the union back. ci.yml's check.ts
// asserts the same thing from OUTSIDE the package, against the emitted .d.ts.
test('storageUnavailable cannot carry a reason that means storage works', () => {
  const narrow: MentioraEvent = { type: 'storageUnavailable', reason: 'peer-absent' };
  // @ts-expect-error 'override' is not a StorageUnavailableReason
  const wide: MentioraEvent = { type: 'storageUnavailable', reason: 'override' };
  expect([narrow, wide]).toHaveLength(2);
});
