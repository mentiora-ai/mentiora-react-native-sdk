/**
 * Public API for @mentiora/react-native-sdk. Exports only — no logic here.
 *
 * Every name is listed one by one because each is a public API commitment:
 * `export *` from `./MentioraWidget.js` or `./presenter.js` would also ship
 * their `__`-prefixed test helpers, and `./back-channel.js` is internal
 * plumbing, deliberately absent.
 *
 * The `.js` extensions are load-bearing: `tsconfig` emits ESM into
 * `lib/module`, where an extensionless specifier does not resolve.
 */

export { MentioraWidget } from './MentioraWidget.js';
/**
 * `Mentiora` presents the widget over a Modal; `MentioraHost` is the component
 * the customer mounts once at their app root to host it, and
 * `Mentiora.open()` throws without one. Every open mounts a fresh WebView; the
 * page resumes the thread from server state, so nothing is kept alive between
 * opens.
 */
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
