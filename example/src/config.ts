import type { MentioraIdentity } from '@mentiora/react-native-sdk';
import { note } from './event-log';
import { issueIdentityToken } from './fake-backend';

// Expo inlines `EXPO_PUBLIC_*` only for literal `process.env.EXPO_PUBLIC_X` access;
// `process.env[name]` and destructuring silently yield `undefined`.
const widgetUrl = process.env.EXPO_PUBLIC_MENTIORA_WIDGET_URL ?? '';
const identitySecret = process.env.EXPO_PUBLIC_MENTIORA_IDENTITY_SECRET ?? '';

// Inverse of the SDK's `${widgetOrigin}/h/rn/${embedKey}`.
const parsed = /^(https?:\/\/[^/]+)\/h\/rn\/([^/?#]+)/.exec(widgetUrl.trim());

const decodeOrEmpty = (raw: string | undefined): string => {
  if (raw === undefined) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    // Throwing at module scope would prevent the setup screen from rendering.
    return '';
  }
};

export const widgetOrigin = parsed?.[1] ?? '';
export const embedKey = decodeOrEmpty(parsed?.[2]);
export const isConfigured = widgetOrigin !== '' && embedKey !== '';

export const isMalformed = widgetUrl.trim() !== '' && !isConfigured;

export const widgetUrlDisplay = widgetUrl.trim();

/** Identity key secret (Mentiora admin: Embed → Identity keys). A real app keeps it on its
 *  server; `src/fake-backend.ts` stands in for one. Unset means Sign in is disabled. */
const backendSecret = identitySecret.trim();

export const canSignIn = backendSecret !== '';

// Read on every mint, so changing credentials never replaces `identityFetcher`.
let currentSub = '';
let currentName = '';
export const setCredentials = (sub: string, name: string): void => {
  currentSub = sub;
  currentName = name;
};

/**
 * Built once: the SDK compares `identity` by reference and a new object discards its
 * cached token. Against a real backend, `getToken` becomes a `fetch` to your token
 * endpoint, or use the declarative `{ endpoint, headers, body }` form.
 */
export const identityFetcher: MentioraIdentity = {
  getToken: async () => {
    try {
      return await issueIdentityToken(backendSecret, {
        sub: currentSub,
        // Non-reserved claims land on the end user's profile.
        claims: currentName === '' ? {} : { name: currentName },
      });
    } catch (error) {
      note(`mint failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  },
};
