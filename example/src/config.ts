import type { MentioraIdentity } from '@mentiora-ai/react-native-sdk';
import { note } from './event-log';
import { issueIdentityToken } from './fake-backend';

// Expo inlines `EXPO_PUBLIC_*` only for literal `process.env.EXPO_PUBLIC_X` access;
// `process.env[name]` and destructuring silently yield `undefined`.
export const widgetUrl = (process.env.EXPO_PUBLIC_MENTIORA_WIDGET_URL ?? '').trim();
const identitySecret = process.env.EXPO_PUBLIC_MENTIORA_IDENTITY_SECRET ?? '';

// Mirrors `Mentiora.configure()`'s check so a bad value shows the setup screen, not a throw.
export const isConfigured = /^https?:\/\/[^/?#]+\/h\/rn\/[^/?#]+\/?$/.test(widgetUrl);

export const isMalformed = widgetUrl !== '' && !isConfigured;

/** Mentiora admin: Embed → Identity keys. A real app keeps this on its server. */
const backendSecret = identitySecret.trim();

export const canSignIn = backendSecret !== '';

let currentSub = '';
let currentName = '';
export const setCredentials = (sub: string, name: string): void => {
  currentSub = sub;
  currentName = name;
};

/** Built once: the SDK compares `identity` by reference and drops its cached token on change.
 *  A real `getToken` fetches your token endpoint, or use `{ endpoint, headers, body }`. */
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
