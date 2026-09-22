// Named `.tsx`, not `.ts`: `jest.config.js` matches only `src/**/*.test.tsx` and
// `tsconfig.test.json` excludes `src/__tests__`, so a `.ts` file here is compiled
// by nothing and run by nothing — a suite that silently never executes.

import type { MentioraEvent } from '../index';
import * as sdk from '../index';

// `expect(typeof sdk.MentioraWidget).toBe('function')` proves nothing: a stub is a
// function too. The stub is gone only if calling the surface does not throw.
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

// `storageUnavailable`'s `reason` stays narrower than the internal `StorageReason`:
// `'override'` and `'peer-loaded'` both mean storage works, so carrying them would
// hand every consumer two switch arms that are dead by construction. A compile-time
// assertion — `bun run typecheck` covers `src/__tests__`, and the `@ts-expect-error`
// below fails the build if the union is widened back.
test('storageUnavailable cannot carry a reason that means storage works', () => {
  const narrow: MentioraEvent = { type: 'storageUnavailable', reason: 'peer-absent' };
  // @ts-expect-error 'override' is not a StorageUnavailableReason
  const wide: MentioraEvent = { type: 'storageUnavailable', reason: 'override' };
  expect([narrow, wide]).toHaveLength(2);
});
