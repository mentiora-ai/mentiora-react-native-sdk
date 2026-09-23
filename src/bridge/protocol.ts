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
   * Host -> page, v1.1. Sent when a warm page is shown again without a reload, because
   * the page's own launch signal fires once per document: without it the second and
   * every later open is invisible to the widget's dwell and open/close funnel. A page
   * that predates it drops the notification, which is why this is additive and needs no
   * version bump.
   */
  show: 'mentiora/show',
} as const;

export type Method = (typeof Method)[keyof typeof Method];
