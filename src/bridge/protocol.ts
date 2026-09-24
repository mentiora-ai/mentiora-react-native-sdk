/** Mobile bridge protocol v1 (host role). Every `id` is a non-empty string;
 *  `guards.ts` enforces it. */

export const PROTOCOL_VERSION = 1 as const;

// Typed `readonly number[]` so `.includes()` accepts any page `number` (TS2345).
export const SUPPORTED_VERSIONS: readonly number[] = [PROTOCOL_VERSION];

export const ErrorCode = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  unauthorized: -32001,
  identityUnavailable: -32002,
  urlDenied: -32003,
  unsupportedVersion: -32005,
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const Method = {
  initialize: 'mentiora/initialize',
  refreshIdentity: 'mentiora/refreshIdentity',
  openUrl: 'mentiora/openUrl',
  ready: 'mentiora/ready',
  identityError: 'mentiora/identityError',
  close: 'mentiora/close',
  backHandling: 'mentiora/backHandling',
  back: 'mentiora/back',
  /**
   * Host -> page, v1.1. `show` and `hide` report the warm overlay's visibility to the
   * page's open/close signals: the page's own launch signal fires once per document, and
   * a park through back or `close()` never reaches it. `InitializeResult.visible` covers
   * a document that loads while parked. A page that predates them drops both
   * notifications, which is why they are additive and need no version bump.
   */
  show: 'mentiora/show',
  hide: 'mentiora/hide',
} as const;

export type Method = (typeof Method)[keyof typeof Method];
