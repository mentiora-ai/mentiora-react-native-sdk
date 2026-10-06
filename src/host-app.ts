/**
 * `appId` and `brand` in the `initialize` result; the platform resolves a conversation's
 * brand from them. React Native exposes neither the bundle id nor the package name, and a
 * native module would end Expo Go support, so `appId` comes from Expo's optional modules.
 * A bare app without them sends none.
 */
import { Platform } from 'react-native';

const MAX_APP_ID = 255;
const MAX_BRAND = 64;

type ExpoApplication = { applicationId?: unknown };
type ExpoConstants = {
  default?: {
    expoConfig?: {
      ios?: { bundleIdentifier?: unknown };
      android?: { package?: unknown };
    } | null;
  };
};

const appIdOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id.length > 0 && id.length <= MAX_APP_ID ? id : undefined;
};

// A bare `require` in the ESM build throws a `ReferenceError`.
export const loadAppId = (
  hasRequire: () => boolean = () => typeof require === 'function',
  requireApplication?: () => unknown,
  requireConstants?: () => unknown,
): string | undefined => {
  if (!hasRequire()) return undefined;
  try {
    // Directly inside `try`, or Metro fails the bundle when the peer is missing.
    // Reads the native value; throws when the app was not rebuilt with it.
    const mod = (
      requireApplication ? requireApplication() : require('expo-application')
    ) as ExpoApplication;
    const id = appIdOf(mod.applicationId);
    if (id) return id;
  } catch {
    // Absent or unlinked: fall through to the app config.
  }
  try {
    // Every Expo app has it. Prebuild writes the config's id into the native project.
    const mod = (
      requireConstants ? requireConstants() : require('expo-constants')
    ) as ExpoConstants;
    const config = mod.default?.expoConfig;
    if (Platform.OS === 'ios') return appIdOf(config?.ios?.bundleIdentifier);
    if (Platform.OS === 'android') return appIdOf(config?.android?.package);
    return undefined;
  } catch {
    return undefined;
  }
};

/** Trimmed; blank means unset. The platform checks it against the project's brands. */
export const parseBrand = (brand: unknown): string | undefined => {
  if (brand === undefined || brand === null) return undefined;
  const key = typeof brand === 'string' ? brand.trim() : null;
  if (key === null || key.length > MAX_BRAND) {
    throw new Error(
      `mentiora: brand must be a string of at most ${MAX_BRAND} characters, like "be"; ` +
        `got ${JSON.stringify(brand)}.`,
    );
  }
  return key.length > 0 ? key : undefined;
};
