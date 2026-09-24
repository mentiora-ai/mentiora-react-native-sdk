import type React from 'react';
import type { MentioraStrings } from './ui/strings.js';

export type { MentioraStrings };

/** Resolve an identity token yourself. Called at boot and on every refresh. */
export interface MentioraIdentityCallback {
  getToken: () => string | Promise<string>;
}

/** Let the SDK fetch identity tokens: it reads the JWT's `exp` without
 *  verifying, caches the token in memory and refreshes before expiry. */
export interface MentioraIdentityFetcher {
  endpoint: string;
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  body?: () => unknown;
}

export type MentioraIdentity = MentioraIdentityCallback | MentioraIdentityFetcher;

/** Read by the host app through `onEvent`; the error screen never shows it. */
export type MentioraErrorCode = 'load_failed' | 'handshake_timeout' | 'renderer_crashed';

/** Why the SDK fell back to in-memory storage: install the AsyncStorage peer
 *  (`peer-absent`), pass `storage` (`no-require`), or fix yours (`load-threw`). */
export type StorageUnavailableReason = 'peer-absent' | 'no-require' | 'load-threw';

export type MentioraEvent =
  | { type: 'ready' }
  | { type: 'close' }
  | { type: 'identityError'; reason: string }
  | { type: 'openUrl'; url: string }
  | { type: 'error'; code: MentioraErrorCode }
  /** The install id lives in memory, so every launch is a new anonymous user.
   *  Emitted once per embed key. */
  | { type: 'storageUnavailable'; reason: StorageUnavailableReason };

/** What `renderError` receives: the same actions the built-in Retry and Dismiss run. */
export type MentioraErrorRenderProps = {
  code: MentioraErrorCode;
  /** A fresh load of the page. */
  retry: () => void;
  /** Stops showing the widget and emits `close`, which closes the `Mentiora.open()` overlay. */
  dismiss: () => void;
};

/** Overrides the AsyncStorage default used to persist the install id. */
export interface MentioraStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}

export interface MentioraConfig {
  /**
   * The hosted-page URL from the Mentiora install snippet, e.g.
   * `https://widget.acme.mentiora.ai/h/rn/pk_wgt_…`. Anything else throws, from
   * `Mentiora.configure()` or on the widget's first render.
   */
  widgetUrl: string;
  /** Omitted means anonymous chat. */
  identity?: MentioraIdentity;
  onEvent?: (event: MentioraEvent) => void;
  /** Return true to take over. Default opens https:, mailto: and tel: via Linking. */
  onOpenUrl?: (url: string) => boolean;
  storage?: MentioraStorage;
  /** Overrides the error screen's copy; an `undefined` key keeps its default. */
  strings?: Partial<MentioraStrings>;
  /**
   * Replaces the built-in error screen, e.g. to match the app's own design. It fills the
   * widget's area, so it must offer a way out: without `dismiss` the user is stuck on it.
   * `strings` does not apply to it. `onEvent` still reports the `error`.
   */
  renderError?: (props: MentioraErrorRenderProps) => React.ReactNode;
}

export type MentioraWidgetProps = MentioraConfig & {
  /**
   * `false` parks the widget: it stays mounted and keeps its page, but stops claiming
   * the Android back button and is hidden from screen readers. `<MentioraHost />` sets
   * it to keep the page warm across close/open. Inline hosts can set it for a widget in
   * a tab that is not on screen; leaving it out means visible.
   */
  visible?: boolean;
};
