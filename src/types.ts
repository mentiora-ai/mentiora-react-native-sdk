import type { MentioraStrings } from './ui/strings.js';

export type { MentioraStrings };

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

/**
 * Why the SDK fell back to in-memory storage. Each value names a different
 * fix: install the optional AsyncStorage peer (`peer-absent`), pass `storage`
 * explicitly because this build cannot auto-resolve a peer at all
 * (`no-require`), or look at the store you passed (`load-threw`).
 *
 * Deliberately narrower than `storage.ts`'s internal `StorageReason`, which
 * also has `'override'` and `'peer-loaded'`: those two mean storage WORKS, so
 * they can never accompany a `storageUnavailable` event. Carrying them on the
 * public union would hand every consumer two switch arms that are dead by
 * construction, forever.
 */
export type StorageUnavailableReason = 'peer-absent' | 'no-require' | 'load-threw';

export type MentioraEvent =
  | { type: 'ready' }
  | { type: 'close' }
  | { type: 'identityError'; reason: string }
  | { type: 'openUrl'; url: string }
  | { type: 'error'; code: MentioraErrorCode }
  /**
   * design.md §2.4: no AsyncStorage and no `storage` override means the
   * install id lives in memory, so every launch creates a new anonymous user
   * with no thread continuity. The `__DEV__` warning that goes out alongside
   * this is stripped from release bundles, where the failure otherwise shows
   * up only as inflated anonymous user counts — hence an event too. Emitted
   * once per embed key, not once per presentation.
   */
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
  /** Overrides the error screen's copy (the only chrome this SDK itself ever
   *  draws — the hosted page draws everything else). An explicit `undefined`
   *  on a key is ignored, falling back to the default for that key alone. */
  strings?: Partial<MentioraStrings>;
}

export type MentioraWidgetProps = MentioraConfig;
