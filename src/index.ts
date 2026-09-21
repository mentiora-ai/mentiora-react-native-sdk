/**
 * Public API for @mentiora/react-native-sdk (design.md §1).
 *
 * Exports only — no logic lives here. Every name below is a public API
 * commitment, so they are listed one by one: `export *` from
 * `./MentioraWidget.js` or `./presenter.js` would also ship their
 * `__`-prefixed test helpers, and `./back-channel.js` is internal plumbing
 * that is deliberately absent.
 *
 * The `.js` extensions are load-bearing: `tsconfig` emits ESM into
 * `lib/module`, where an extensionless specifier does not resolve.
 */

export { MentioraWidget } from './MentioraWidget.js';
/**
 * `Mentiora` presents the widget over a Modal; `MentioraHost` is the
 * component the customer mounts once at their app root to host it —
 * `Mentiora.open()` throws without one. The Modal mounts a fresh WebView on
 * every open (design.md §2.7); the page resumes the thread from server state,
 * so nothing is kept alive between opens.
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
