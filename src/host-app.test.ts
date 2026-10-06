import assert from 'node:assert/strict';
import { Platform } from 'react-native';
import { loadAppId, parseBrand } from './host-app.js';

const has = () => true;
const missing = () => {
  throw new Error('Requiring unknown module "undefined"');
};
const constants = {
  default: {
    expoConfig: {
      ios: { bundleIdentifier: 'com.acme.ios' },
      android: { package: 'com.acme.android' },
    },
  },
};

const onPlatform = (os: 'ios' | 'android', run: () => void): void => {
  const real = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(Platform, 'OS', { value: real, configurable: true });
  }
};

test('expo-application wins: it reads the native id', () => {
  assert.equal(
    loadAppId(
      has,
      () => ({ applicationId: 'com.acme.nl' }),
      () => constants,
    ),
    'com.acme.nl',
  );
});

test('without expo-application the app config gives the id for the running platform', () => {
  onPlatform('ios', () =>
    assert.equal(
      loadAppId(has, missing, () => constants),
      'com.acme.ios',
    ),
  );
  onPlatform('android', () =>
    assert.equal(
      loadAppId(has, missing, () => constants),
      'com.acme.android',
    ),
  );
});

test('a null or blank applicationId falls through to the app config', () => {
  onPlatform('ios', () => {
    assert.equal(
      loadAppId(
        has,
        () => ({ applicationId: null }),
        () => constants,
      ),
      'com.acme.ios',
    );
    assert.equal(
      loadAppId(
        has,
        () => ({ applicationId: ' ' }),
        () => constants,
      ),
      'com.acme.ios',
    );
  });
});

test('no peer, no config id, an over-long id or no require: undefined, never null or ""', () => {
  assert.equal(loadAppId(has, missing, missing), undefined);
  assert.equal(
    loadAppId(has, missing, () => ({ default: { expoConfig: null } })),
    undefined,
  );
  assert.equal(
    loadAppId(has, () => ({ applicationId: 'a'.repeat(256) }), missing),
    undefined,
  );
  assert.equal(
    loadAppId(
      () => false,
      () => ({ applicationId: 'com.acme.nl' }),
    ),
    undefined,
  );
});

test('brand is trimmed, and unset or blank means absent', () => {
  assert.equal(parseBrand(' be '), 'be');
  assert.equal(parseBrand('b'.repeat(64)), 'b'.repeat(64));
  assert.equal(parseBrand(undefined), undefined);
  assert.equal(parseBrand(null), undefined);
  assert.equal(parseBrand('  '), undefined);
});

test('a non-string or over-long brand throws', () => {
  assert.throws(() => parseBrand('b'.repeat(65)), /brand must be a string of at most 64/);
  assert.throws(() => parseBrand(1), /brand/);
});
