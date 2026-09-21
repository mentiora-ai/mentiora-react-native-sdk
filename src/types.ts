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

/**
 * Distinguishes a dead network from a page that loaded and never spoke.
 * Never shown to the user — the error screen renders the same sentence for
 * all three; the code is read by the host app through `onEvent`.
 */
export type MentioraErrorCode = 'load_failed' | 'handshake_timeout' | 'renderer_crashed';

export type MentioraEvent =
  | { type: 'ready' }
  | { type: 'close' }
  | { type: 'identityError'; reason: string }
  | { type: 'openUrl'; url: string }
  | { type: 'error'; code: MentioraErrorCode };

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
