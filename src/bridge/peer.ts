/**
 * The host side of the JSON-RPC 2.0 bridge (mobile bridge protocol v1). The
 * hosted page is the client and sends every request; this peer answers.
 *
 * `receive` checks in this order:
 * 1. `parseInbound`. `null` answers `-32600` when the raw text carried a
 *    string `id`, otherwise drops.
 * 2. `mentiora/initialize`: a request only (an id-less notification is
 *    dropped and never spends the latch); params are validated first, then
 *    the latch, which is reserved before the handler is awaited. No
 *    session-key comparison, and whatever `protocolVersion` the handler
 *    returns is forwarded as-is.
 * 3. Every other message: `params.sessionKey` must equal the stored key. A
 *    mismatch answers `-32001` when the message has an `id`; an id-less one
 *    is dropped with a `warn`, because JSON-RPC cannot answer a message
 *    with no id — a deviation from the wire contract, which asks for
 *    `-32001` on notifications too.
 * 4. Route by method. Unknown ⇒ `-32601`. Bad params ⇒ `-32602`. A
 *    handler that throws ⇒ `-32603`.
 *
 * Every outbound message carries `params.sessionKey` once a session exists,
 * error responses included.
 *
 * `resetLoad` bumps a generation counter and clears the latch and session
 * key. A `receive` captures the generation on entry and, once it no longer
 * matches, neither mutates state nor sends: an `initialize` awaiting the
 * page's random bytes would otherwise answer into the replacement page or
 * overwrite its session key.
 */

import {
  isBackHandlingParams,
  isIdentityErrorParams,
  isInitializeParams,
  isOpenUrlParams,
  parseInbound,
} from './guards.js';
import { ErrorCode, Method } from './protocol.js';

export type InitializeResult = {
  protocolVersion: number;
  sessionKey: string;
  installId: string;
  identityToken?: string;
  sdk: { name: string; version: string };
  threadId?: string;
};

export type HostHandlers = {
  initialize: (params: { protocolVersion: number }) => Promise<InitializeResult>;
  refreshIdentity: () => Promise<{ identityToken: string }>;
  openUrl: (url: string) => Promise<void>;
  onReady: () => void;
  onClose: () => void;
  onIdentityError: (reason: string, message: string) => void;
  onBackHandling: (active: boolean) => void;
};

/**
 * A handler error that names its own JSON-RPC code. Any other throw becomes
 * `-32603`, leaving the protocol's `-32003` (URL denied) and `-32002`
 * (identity unavailable) unreachable, so the composition root labels the
 * throw and the peer need not know those domains.
 *
 * `message` reaches the page verbatim, unlike the generic `-32603` answer, so
 * it must be a fixed literal — never an upstream error's text, a URL or a
 * token.
 */
export class BridgeError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

export type HostPeer = {
  receive: (raw: string) => Promise<void>;
  sendBack: () => void;
  resetLoad: () => void;
  sessionKey: () => string | null;
};

// Best-effort id extraction for a payload that failed `parseInbound`, used
// only to decide whether the parse failure is answerable at all. Validated
// no further than "a non-empty string".
const extractRawId = (raw: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const id = (parsed as Record<string, unknown>).id;
      if (typeof id === 'string' && id.length > 0) return id;
    }
  } catch {
    // not JSON at all
  }
  return undefined;
};

const failure = (e: unknown): { code: number; message: string } =>
  e instanceof BridgeError
    ? { code: e.code, message: e.message }
    : { code: ErrorCode.internalError, message: 'Internal error' };

export const createHostPeer = (deps: {
  send: (raw: string) => void;
  handlers: HostHandlers;
  warn?: (msg: string) => void;
}): HostPeer => {
  const { send, handlers } = deps;
  const warn = deps.warn ?? (() => {});

  let generation = 0;
  let initializeLatch = false;
  let currentSessionKey: string | null = null;

  const withSessionParams = <T extends Record<string, unknown>>(
    obj: T,
  ): T & { params?: { sessionKey: string } } =>
    currentSessionKey === null ? obj : { ...obj, params: { sessionKey: currentSessionKey } };

  const sendResult = (id: string, result: unknown): void => {
    send(JSON.stringify(withSessionParams({ jsonrpc: '2.0', id, result })));
  };

  const sendError = (id: string, code: number, message: string, data?: unknown): void => {
    const error = data === undefined ? { code, message } : { code, message, data };
    send(JSON.stringify(withSessionParams({ jsonrpc: '2.0', id, error })));
  };

  // JSON-RPC has no envelope for a reply with no id, so an id-less message
  // is warned about and dropped rather than answered.
  const respondOrDrop = (
    id: string | undefined,
    code: number,
    message: string,
    data?: unknown,
  ): void => {
    if (id === undefined) {
      warn(`mentiora bridge: dropping id-less rejected message (${message})`);
      return;
    }
    sendError(id, code, message, data);
  };

  const receive = async (raw: string): Promise<void> => {
    const myGen = generation;
    const message = parseInbound(raw);

    if (message === null) {
      respondOrDrop(extractRawId(raw), ErrorCode.invalidRequest, 'Invalid Request');
      return;
    }

    if (!('method' in message)) {
      // A response carries an id, so it is answerable, but there is nothing
      // to route it to — only the session key applies.
      const providedKey = message.params?.sessionKey;
      if (currentSessionKey === null || providedKey !== currentSessionKey) {
        respondOrDrop(message.id, ErrorCode.unauthorized, 'Unauthorized', {
          reason: 'missing_session_key',
        });
      }
      return;
    }

    if (message.method === Method.initialize) {
      if (!('id' in message)) return; // id-less notification: dropped, latch untouched

      const { id } = message;
      if (!isInitializeParams(message.params)) {
        sendError(id, ErrorCode.invalidParams, 'Invalid params');
        return;
      }
      if (initializeLatch) {
        sendError(id, ErrorCode.invalidRequest, 'initialize already completed for this page load');
        return;
      }

      initializeLatch = true; // reserved before the handler is awaited, not after
      try {
        const result = await handlers.initialize({
          protocolVersion: message.params.protocolVersion,
        });
        if (myGen !== generation) return; // superseded load: neither mutate nor send
        currentSessionKey = result.sessionKey;
        sendResult(id, result);
      } catch {
        if (myGen !== generation) return;
        sendError(id, ErrorCode.internalError, 'Internal error');
      }
      return;
    }

    const id = 'id' in message ? message.id : undefined;
    const providedKey = message.params.sessionKey;
    if (currentSessionKey === null || providedKey !== currentSessionKey) {
      respondOrDrop(id, ErrorCode.unauthorized, 'Unauthorized', { reason: 'missing_session_key' });
      return;
    }

    switch (message.method) {
      case Method.refreshIdentity: {
        try {
          const result = await handlers.refreshIdentity();
          if (myGen !== generation) return;
          if (id !== undefined) sendResult(id, result);
        } catch (e) {
          if (myGen !== generation) return;
          const { code, message } = failure(e);
          respondOrDrop(id, code, message);
        }
        return;
      }
      case Method.openUrl: {
        if (!isOpenUrlParams(message.params)) {
          respondOrDrop(id, ErrorCode.invalidParams, 'Invalid params');
          return;
        }
        try {
          await handlers.openUrl(message.params.url);
          if (myGen !== generation) return;
          if (id !== undefined) sendResult(id, null);
        } catch (e) {
          if (myGen !== generation) return;
          const { code, message } = failure(e);
          respondOrDrop(id, code, message);
        }
        return;
      }
      case Method.ready: {
        handlers.onReady();
        return;
      }
      case Method.close: {
        handlers.onClose();
        return;
      }
      case Method.identityError: {
        if (!isIdentityErrorParams(message.params)) {
          respondOrDrop(id, ErrorCode.invalidParams, 'Invalid params');
          return;
        }
        handlers.onIdentityError(message.params.reason, message.params.message);
        return;
      }
      case Method.backHandling: {
        if (!isBackHandlingParams(message.params)) {
          respondOrDrop(id, ErrorCode.invalidParams, 'Invalid params');
          return;
        }
        handlers.onBackHandling(message.params.active);
        return;
      }
      default: {
        respondOrDrop(id, ErrorCode.methodNotFound, 'Method not found');
      }
    }
  };

  const sendBack = (): void => {
    if (currentSessionKey === null) return;
    send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: Method.back,
        params: { sessionKey: currentSessionKey },
      }),
    );
  };

  const resetLoad = (): void => {
    generation += 1;
    initializeLatch = false;
    currentSessionKey = null;
  };

  return { receive, sendBack, resetLoad, sessionKey: () => currentSessionKey };
};
