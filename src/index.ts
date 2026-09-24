// Named exports only: `export *` would also ship the `__`-prefixed test helpers.
// The `.js` extensions are required by the emitted ESM.

export { MentioraWidget } from './MentioraWidget.js';
/** `MentioraHost` must be mounted once at the app root or `Mentiora.open()` throws. */
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
