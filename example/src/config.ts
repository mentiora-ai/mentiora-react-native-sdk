import type { MentioraIdentity } from '@mentiora/react-native-sdk';
import { note } from './event-log';
import { issueIdentityToken } from './fake-backend';

// Expo inlines `EXPO_PUBLIC_*` only for literal `process.env.EXPO_PUBLIC_X` access;
// `process.env[name]` and destructuring silently yield `undefined`.
export const widgetUrl = (process.env.EXPO_PUBLIC_MENTIORA_WIDGET_URL ?? '').trim();
const identitySecret = process.env.EXPO_PUBLIC_MENTIORA_IDENTITY_SECRET ?? '';

// The shape `Mentiora.configure()` accepts. Checked here too so a bad value shows the setup
// screen instead of throwing from the first `configure()`.
export const isConfigured = /^https?:\/\/[^/?#]+\/h\/rn\/[^/?#]+\/?$/.test(widgetUrl);

export const isMalformed = widgetUrl !== '' && !isConfigured;

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
