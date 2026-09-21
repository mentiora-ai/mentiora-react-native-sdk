/**
 * Public API for @mentiora/react-native-sdk.
 *
 * Scaffold stub: the shapes below are the approved v0 surface (design.md §1).
 * Every implementation throws until the bridge lands, so the packaging, the
 * emitted .d.ts and the consumer install check are all exercised before any
 * protocol code exists.
 */

import { SDK_VERSION } from './version.js';

export { SDK_NAME, SDK_VERSION } from './version.js';

/** Resolve an identity token yourself. Called at boot and on every refresh. */
export interface MentioraIdentityCallback {
  getToken: () => string | Promise<string>;
}

/**
 * Let the SDK fetch identity tokens. It decodes the JWT's `exp` without
 * verifying it, caches the token in memory and refreshes before expiry.
 */
export interface MentioraIdentityFetcher {
  endpoint: string;
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  body?: () => unknown;
}

export type MentioraIdentity = MentioraIdentityCallback | MentioraIdentityFetcher;

export type MentioraEvent =
  | { type: 'ready' }
  | { type: 'close' }
  | { type: 'identityError'; reason: string }
  | { type: 'openUrl'; url: string };

/** Overrides the AsyncStorage default used to persist the install id. */
export interface MentioraStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}

export interface MentioraConfig {
  /** Per tenant, e.g. https://widget.acme.mentiora.ai. No default is safe. */
  widgetOrigin: string;
  /** `pk_wgt_…`. The SDK loads `${widgetOrigin}/h/rn/${embedKey}`. */
  embedKey: string;
  /** Omitted means anonymous chat. */
  identity?: MentioraIdentity;
  onEvent?: (event: MentioraEvent) => void;
  /** Return true to take over. Default opens https:, mailto: and tel: via Linking. */
  onOpenUrl?: (url: string) => boolean;
  storage?: MentioraStorage;
}

export type MentioraWidgetProps = MentioraConfig;

const notImplemented = (what: string): never => {
  throw new Error(
    `@mentiora/react-native-sdk@${SDK_VERSION}: ${what} is not implemented yet. ` +
      'This is a scaffold release; the bridge lands in 0.1.0.',
  );
};

/** Embed the widget inline. Renders no chrome: the page draws its own header. */
export function MentioraWidget(_props: MentioraWidgetProps): never {
  return notImplemented('<MentioraWidget />');
}

/**
 * Presenter. Keeps one WebView mounted across open and close, so opening does
 * not reload the page.
 */
export const Mentiora = {
  configure(_config: MentioraConfig): void {
    notImplemented('Mentiora.configure()');
  },
  open(): Promise<void> {
    return notImplemented('Mentiora.open()');
  },
  close(): void {
    notImplemented('Mentiora.close()');
  },
  /** Rotates the install id, drops the cached token and reloads the page. */
  logout(): Promise<void> {
    return notImplemented('Mentiora.logout()');
  },
};
