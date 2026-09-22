/**
 * Hand-written guards for every inbound (page → host) JSON-RPC message. No
 * zod: the package keeps zero runtime dependencies.
 *
 * Contract, enforced here:
 * - `id`, when present, is a non-empty string. A numeric id is invalid.
 * - `params` is required on requests and notifications, and a sender that
 *   omits it is read as `{}` rather than dropped — dropping hangs the
 *   sender's caller for its full 30s timeout. A response carries `params`
 *   too, since that is where `params.sessionKey` lives, and gets the same
 *   treatment: a page's response is itself a page → host message the
 *   session-key rule applies to.
 * - Unknown top-level fields are ignored; `parseInbound` copies out only the
 *   fields it recognises.
 * - A response carries an `id` plus exactly one of `result` or `error`, and
 *   never a `method`.
 */

export type JsonRpcId = string;

type JsonRpcParams = Record<string, unknown>;

export interface InboundRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params: JsonRpcParams;
}

export interface InboundNotification {
  jsonrpc: '2.0';
  method: string;
  params: JsonRpcParams;
}

export interface InboundErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export type InboundResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown; params?: JsonRpcParams }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: InboundErrorPayload; params?: JsonRpcParams };

export type InboundMessage = InboundRequest | InboundNotification | InboundResponse;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const isJsonRpcId = (v: unknown): v is JsonRpcId => isNonEmptyString(v);

const isJsonRpcParams = (v: unknown): v is JsonRpcParams => isPlainObject(v);

const isErrorPayload = (v: unknown): v is InboundErrorPayload =>
  isPlainObject(v) &&
  typeof v.code === 'number' &&
  Number.isInteger(v.code) &&
  typeof v.message === 'string';

// Structural checks only. Run them on `parseInbound`'s normalised output,
// not on a raw `postMessage` payload: they do not default a missing
// `params`, only `parseInbound` does.

export function isRequest(v: unknown): v is InboundRequest {
  if (!isPlainObject(v)) return false;
  if (v.jsonrpc !== '2.0') return false;
  if (!isJsonRpcId(v.id)) return false;
  if (!isNonEmptyString(v.method)) return false;
  return isJsonRpcParams(v.params);
}

export function isNotification(v: unknown): v is InboundNotification {
  if (!isPlainObject(v)) return false;
  if (v.jsonrpc !== '2.0') return false;
  if ('id' in v && v.id !== undefined) return false;
  if (!isNonEmptyString(v.method)) return false;
  return isJsonRpcParams(v.params);
}

export function isResponse(v: unknown): v is InboundResponse {
  if (!isPlainObject(v)) return false;
  if (v.jsonrpc !== '2.0') return false;
  if ('method' in v && v.method !== undefined) return false;
  if (!isJsonRpcId(v.id)) return false;
  const hasResult = 'result' in v && v.result !== undefined;
  const hasError = 'error' in v && v.error !== undefined;
  if (hasResult === hasError) return false; // exactly one of result / error
  if (hasError && !isErrorPayload(v.error)) return false;
  const hasParams = 'params' in v && v.params !== undefined;
  if (hasParams && !isJsonRpcParams(v.params)) return false;
  return true;
}

/**
 * Parses a raw `onMessage` payload into a normalised {@link InboundMessage},
 * or `null` when it does not conform to the protocol.
 *
 * Rejects non-JSON, arrays, non-objects and non-2.0 envelopes, and requires
 * a non-empty string `id` when one is present. A missing `params` reads as
 * `{}` on requests, notifications and responses alike; a present but
 * malformed one rejects. Copies out only recognised fields, so an unknown
 * top-level field is ignored rather than a reason to reject.
 */
export function parseInbound(raw: string): InboundMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isPlainObject(parsed)) return null;
  if (parsed.jsonrpc !== '2.0') return null;

  const hasId = 'id' in parsed && parsed.id !== undefined;
  if (hasId && !isJsonRpcId(parsed.id)) return null; // numeric / empty ids are invalid

  const hasMethod = 'method' in parsed && parsed.method !== undefined;
  const hasResult = 'result' in parsed && parsed.result !== undefined;
  const hasError = 'error' in parsed && parsed.error !== undefined;

  if (hasMethod) {
    // A response never carries a method.
    if (hasResult || hasError) return null;
    if (!isNonEmptyString(parsed.method)) return null;

    const rawParams = parsed.params;
    if (rawParams !== undefined && !isJsonRpcParams(rawParams)) return null;
    const params: JsonRpcParams = isJsonRpcParams(rawParams) ? rawParams : {};

    if (hasId) {
      const id = parsed.id;
      if (typeof id !== 'string') return null;
      return { jsonrpc: '2.0', id, method: parsed.method, params };
    }
    return { jsonrpc: '2.0', method: parsed.method, params };
  }

  // No method: only a response is left.
  if (!hasId) return null;
  const id = parsed.id;
  if (typeof id !== 'string') return null;
  if (hasResult === hasError) return null; // exactly one of result / error

  // A response's `params` is where `params.sessionKey` lives, and the
  // session-key rule applies to page-sent responses too.
  const rawParams = parsed.params;
  if (rawParams !== undefined && !isJsonRpcParams(rawParams)) return null;
  const params: JsonRpcParams = isJsonRpcParams(rawParams) ? rawParams : {};

  if (hasError) {
    if (!isErrorPayload(parsed.error)) return null;
    return { jsonrpc: '2.0', id, error: parsed.error, params };
  }
  return { jsonrpc: '2.0', id, result: parsed.result, params };
}

export function isInitializeParams(v: unknown): v is { protocolVersion: number } {
  return isPlainObject(v) && typeof v.protocolVersion === 'number';
}

export function isOpenUrlParams(v: unknown): v is { url: string } {
  return isPlainObject(v) && typeof v.url === 'string';
}

export function isBackHandlingParams(v: unknown): v is { active: boolean } {
  return isPlainObject(v) && typeof v.active === 'boolean';
}

export function isIdentityErrorParams(v: unknown): v is { reason: string; message: string } {
  return isPlainObject(v) && typeof v.reason === 'string' && typeof v.message === 'string';
}
