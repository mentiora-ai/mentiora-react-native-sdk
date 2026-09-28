import type { MentioraEvent } from '../index';
import * as sdk from '../index';

test('SDK_VERSION matches package.json — release.yml aborts if it does not', () => {
  const pkg = require('../../package.json') as { version: string };
  expect(sdk.SDK_VERSION).toBe(pkg.version);
  expect(sdk.SDK_NAME).toBe('@mentiora-ai/react-native-sdk');
});

test('the surface is exactly the approved list — no internals, no test helpers', () => {
  // Value exports only; scripts/check-public-types.ts covers the types from outside the package.
  expect(Object.keys(sdk).sort()).toEqual(
    ['Mentiora', 'MentioraHost', 'MentioraWidget', 'SDK_NAME', 'SDK_VERSION'].sort(),
  );
});

test('the internal test helpers are not reachable through the public entry', () => {
  // All four would ship under `export *`. Named exports are what keeps them out.
  expect(Object.keys(sdk).some((k) => k.startsWith('__'))).toBe(false);
  const surface = sdk as unknown as Record<string, unknown>;
  expect(surface.__resetPresenter).toBeUndefined();
  expect(surface.resolveHostInsets).toBeUndefined();
  expect(surface.DEFAULT_STRINGS).toBeUndefined();
});

test('Mentiora carries exactly the documented methods', () => {
  expect(Object.keys(sdk.Mentiora).sort()).toEqual(
    [
      'close',
      'configure',
      'getInstallRef',
      'handleNotificationTap',
      'isMentioraPush',
      'logout',
      'open',
    ].sort(),
  );
});

test('storageUnavailable cannot carry a reason that means storage works', () => {
  const narrow: MentioraEvent = { type: 'storageUnavailable', reason: 'peer-absent' };
  // @ts-expect-error 'override' is not a StorageUnavailableReason
  const wide: MentioraEvent = { type: 'storageUnavailable', reason: 'override' };
  expect([narrow, wide]).toHaveLength(2);
});
