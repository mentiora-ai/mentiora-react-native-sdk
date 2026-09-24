/**
 * Guards for inbound (page → host) JSON-RPC messages. `id`, when present, is a
 * non-empty string. A missing `params` reads as `{}`, since dropping the message
 * would hang the sender for its 30s timeout. Responses carry `params` too, for
 * `params.sessionKey`. Unknown top-level fields are ignored.
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

// Structural checks on `parseInbound`'s output; they do not default `params`.

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
  if (hasResult === hasError) return false;
  if (hasError && !isErrorPayload(v.error)) return false;
  const hasParams = 'params' in v && v.params !== undefined;
  if (hasParams && !isJsonRpcParams(v.params)) return false;
  return true;
}

/** Parses a raw `onMessage` payload into a normalised {@link InboundMessage},
 *  or `null` when it does not conform. A response needs an `id` and exactly
 *  one of `result`/`error`; a present but malformed `params` rejects. */
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
  if (hasId && !isJsonRpcId(parsed.id)) return null;

  const hasMethod = 'method' in parsed && parsed.method !== undefined;
  const hasResult = 'result' in parsed && parsed.result !== undefined;
  const hasError = 'error' in parsed && parsed.error !== undefined;

  if (hasMethod) {
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

  if (!hasId) return null;
  const id = parsed.id;
  if (typeof id !== 'string') return null;
  if (hasResult === hasError) return null;

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
