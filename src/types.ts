import type React from 'react';
import type { MentioraStrings } from './ui/strings.js';

export type { MentioraStrings };

/** Resolve an identity token yourself. Called at boot and on every refresh. */
export interface MentioraIdentityCallback {
  getToken: () => string | Promise<string>;
}

/** The SDK fetches the token, caches it in memory and refreshes before the JWT's `exp`. */
export interface MentioraIdentityFetcher {
  endpoint: string;
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  body?: () => unknown;
}

export type MentioraIdentity = MentioraIdentityCallback | MentioraIdentityFetcher;

/** Read by the host app through `onEvent`; the error screen never shows it. */
export type MentioraErrorCode = 'load_failed' | 'handshake_timeout' | 'renderer_crashed';

/** Why the SDK fell back to in-memory storage: install the AsyncStorage peer
 *  (`peer-absent`), or it failed to load (`load-threw`) and you can pass `storage`. */
export type StorageUnavailableReason = 'peer-absent' | 'load-threw';

export type MentioraEvent =
  | { type: 'ready' }
  | { type: 'close' }
  | { type: 'identityError'; reason: string }
  | { type: 'openUrl'; url: string }
  | { type: 'error'; code: MentioraErrorCode }
  /** Install id is memory-only: every launch is a new anonymous user. Once per embed key. */
  | { type: 'storageUnavailable'; reason: StorageUnavailableReason }
  /** Unread replies, 0–100. Only sent once the page has loaded (after the first open). */
  | { type: 'unreadCountChanged'; count: number }
  /** Anonymous `installRef` created, or deleted by `logout()` (`null`). Re-key your device token. */
  | { type: 'installRefChanged'; installRef: string | null };

export type MentioraErrorRenderProps = {
  code: MentioraErrorCode;
  retry: () => void;
  /** Emits `close`, which closes the `Mentiora.open()` overlay. */
  dismiss: () => void;
};

/** Overrides the AsyncStorage default used to persist the install id. */
export interface MentioraStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}

export interface MentioraConfig {
  /** Hosted-page URL from the install snippet (`https://widget.acme.mentiora.ai/h/rn/pk_wgt_…`);
   *  anything else throws. */
  widgetUrl: string;
  /** Omitted means anonymous chat. Compared by reference: a new object reloads the page,
   *  so define it outside render. */
  identity?: MentioraIdentity;
  /** Every event the widget raises; a throw is caught. */
  onEvent?: (event: MentioraEvent) => void;
  /** Return true to take over. Default opens https:, mailto: and tel: via Linking. */
  onOpenUrl?: (url: string) => boolean;
  /** Persists the install id; defaults to AsyncStorage. Read once per embed key. */
  storage?: MentioraStorage;
  /** Overrides the error screen's copy; an `undefined` key keeps its default. */
  strings?: Partial<MentioraStrings>;
  /** Replaces the built-in error screen. Must offer `dismiss`, or the user is stuck on it. */
  renderError?: (props: MentioraErrorRenderProps) => React.ReactNode;
}

export type MentioraWidgetProps = MentioraConfig & {
  /** `false` keeps the page loaded but releases Android back and hides it from screen
   *  readers, e.g. for an off-screen tab. Default `true`. */
  visible?: boolean;
};
