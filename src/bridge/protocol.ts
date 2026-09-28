/** Mobile bridge protocol v1. Every `id` is a non-empty string; `guards.ts` enforces it. */

export const PROTOCOL_VERSION = 1 as const;

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
  /** Host -> page, v1.1: warm overlay visibility. Older pages drop them, so no version
   *  bump. A document loaded while parked gets `InitializeResult.visible` instead. */
  show: 'mentiora/show',
  hide: 'mentiora/hide',
  /** Host -> page, warm pages only, after `ready`. A cold load gets
   *  `InitializeResult.threadId` instead. */
  open: 'mentiora/open',
  /** Page -> host notification: total unread, capped at 100; same number as the
   *  `message.missed` webhook's `unreadCount.total`. */
  unreadCountChanged: 'mentiora/unreadCountChanged',
} as const;

export type Method = (typeof Method)[keyof typeof Method];
