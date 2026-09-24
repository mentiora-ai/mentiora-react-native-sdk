// Named `.tsx`, not `.ts`: Jest matches only `*.test.tsx` and tsconfig.test.json
// excludes `src/__tests__`, so a `.ts` file here would silently never execute.

import type { MentioraEvent } from '../index';
import * as sdk from '../index';

// A stub is a function too, so the surface has to be called, not type-checked.
test('the stubs are gone: the surface no longer throws "not implemented"', () => {
  expect(() => sdk.Mentiora.close()).not.toThrow();
  expect(() => sdk.Mentiora.configure({ widgetUrl: 'https://w.x.ai/h/rn/pk_wgt_a' })).not.toThrow();
});

test('SDK_VERSION matches package.json — release.yml aborts if it does not', () => {
  const pkg = require('../../package.json') as { version: string };
  expect(sdk.SDK_VERSION).toBe(pkg.version);
  expect(sdk.SDK_NAME).toBe('@mentiora/react-native-sdk');
});

test('the surface is exactly the approved list — no internals, no test helpers', () => {
  // Value exports only; ci.yml's check.ts covers the types from outside the package.
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

// The public `reason` stays narrower than the internal `StorageReason`: `'override'`
// and `'peer-loaded'` mean storage works, so they would be dead switch arms.
test('storageUnavailable cannot carry a reason that means storage works', () => {
  const narrow: MentioraEvent = { type: 'storageUnavailable', reason: 'peer-absent' };
  // @ts-expect-error 'override' is not a StorageUnavailableReason
  const wide: MentioraEvent = { type: 'storageUnavailable', reason: 'override' };
  expect([narrow, wide]).toHaveLength(2);
});
