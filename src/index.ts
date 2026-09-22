/**
 * Public API for @mentiora/react-native-sdk. Named exports only: `export *`
 * would also ship the `__`-prefixed test helpers, and `./back-channel.js` is
 * internal. The `.js` extensions are load-bearing under the emitted ESM.
 */

export { MentioraWidget } from './MentioraWidget.js';
/** `Mentiora` presents the widget over a Modal; `MentioraHost` must be mounted
 *  once at the app root or `Mentiora.open()` throws. Every open mounts a fresh
 *  WebView and the page resumes the thread from server state. */
export { Mentiora, MentioraHost } from './presenter.js';
export type {
  MentioraConfig,
  MentioraErrorCode,
  MentioraEvent,
  MentioraIdentity,
  MentioraIdentityCallback,
  MentioraIdentityFetcher,
  MentioraStorage,
  MentioraStrings,
  MentioraWidgetProps,
  StorageUnavailableReason,
} from './types.js';
export { SDK_NAME, SDK_VERSION } from './version.js';
