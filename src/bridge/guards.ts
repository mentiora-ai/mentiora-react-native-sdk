// A missing `params` reads as `{}`: dropping the message would hang the sender for its
// 30s timeout. Responses carry `params` too, for `params.sessionKey`.

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

const isErrorPayload = (v: unknown): v is InboundErrorPayload =>
  isPlainObject(v) &&
  typeof v.code === 'number' &&
  Number.isInteger(v.code) &&
  typeof v.message === 'string';

const has = (obj: Record<string, unknown>, key: string): boolean =>
  key in obj && obj[key] !== undefined;

// `undefined` for a malformed `params`; a missing one reads as `{}`.
const readParams = (raw: unknown): JsonRpcParams | undefined => {
  if (raw === undefined) return {};
  return isPlainObject(raw) ? raw : undefined;
};

export function parseInbound(raw: string): InboundMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || parsed.jsonrpc !== '2.0') return null;

  const { id } = parsed;
  if (has(parsed, 'id') && !isNonEmptyString(id)) return null;
  const params = readParams(parsed.params);
  if (params === undefined) return null;

  const hasResult = has(parsed, 'result');
  const hasError = has(parsed, 'error');

  if (has(parsed, 'method')) {
    const { method } = parsed;
    if (hasResult || hasError || !isNonEmptyString(method)) return null;
    return isNonEmptyString(id)
      ? { jsonrpc: '2.0', id, method, params }
      : { jsonrpc: '2.0', method, params };
  }

  if (!isNonEmptyString(id) || hasResult === hasError) return null;
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

export function isUnreadCountParams(v: unknown): v is { count: number } {
  return (
    isPlainObject(v) &&
    typeof v.count === 'number' &&
    Number.isInteger(v.count) &&
    v.count >= 0 &&
    v.count <= 100
  );
}
