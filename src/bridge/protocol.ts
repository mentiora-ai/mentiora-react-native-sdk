/** Mobile bridge protocol v1 (host role). The contract fixes `id` on every
 *  message as a non-empty string, never a number; `guards.ts` enforces it. */

export const PROTOCOL_VERSION = 1 as const;

// `readonly number[]`, not a tuple: `.includes()` takes a page `number` (TS2345).
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
} as const;

export type Method = (typeof Method)[keyof typeof Method];
