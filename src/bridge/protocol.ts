/**
 * Protocol constants for mobile bridge protocol v1 (host role). The contract
 * fixes `id` on every JSON-RPC message as a non-empty string, never a
 * number; `guards.ts` enforces that on every inbound message.
 */

export const PROTOCOL_VERSION = 1 as const;

// `readonly number[]` rather than the narrower `readonly [1]`: callers run
// `SUPPORTED_VERSIONS.includes(protocolVersion)` against a page-supplied
// `number`, which a `readonly [1]` tuple rejects at compile time (TS2345).
// `as const satisfies readonly number[]` does not help — `satisfies` checks
// assignability without widening, so only an explicit annotation widens it.
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
