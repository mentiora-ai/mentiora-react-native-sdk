// Named exports only: `export *` would also ship the `__`-prefixed test helpers.

export { MentioraWidget } from './MentioraWidget.js';
/** `MentioraHost` must be mounted once at the app root; `Mentiora.open()` waits for it. */
export { Mentiora, MentioraHost } from './presenter.js';
export type {
  MentioraConfig,
  MentioraErrorCode,
  MentioraErrorRenderProps,
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
