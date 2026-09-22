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
   *  Once per embed key; the paired `__DEV__` warning is release-stripped. */
  | { type: 'storageUnavailable'; reason: StorageUnavailableReason };

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
  /** Overrides the error screen's copy; an `undefined` key keeps its default. */
  strings?: Partial<MentioraStrings>;
}

export type MentioraWidgetProps = MentioraConfig;
