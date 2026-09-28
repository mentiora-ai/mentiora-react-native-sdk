/**
 * Host side of the JSON-RPC bridge. `initialize` is accepted once per page load without
 * a session key; every other message must carry `params.sessionKey` (-32001).
 */

import {
  isBackHandlingParams,
  isIdentityErrorParams,
  isInitializeParams,
  isOpenUrlParams,
  isUnreadCountParams,
  parseInbound,
} from './guards.js';
import { ErrorCode, Method } from './protocol.js';

export type InitializeResult = {
  protocolVersion: number;
  sessionKey: string;
  installId: string;
  identityToken?: string;
  sdk: { name: string; version: string };
  /** `false` when the document loads while parked, so the page counts no open on `ready`. */
  visible: boolean;
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
  onUnreadCountChanged: (count: number) => void;
};

/** Other errors become -32603. `message` reaches the page verbatim, so it must be a
 *  fixed literal: never upstream error text, a URL or a token. */
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
  sendShow: () => void;
  sendHide: () => void;
  sendOpen: (threadId: string) => void;
  resetLoad: () => void;
  sessionKey: () => string | null;
};

const extractRawId = (raw: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const id = (parsed as Record<string, unknown>).id;
      if (typeof id === 'string' && id.length > 0) return id;
    }
  } catch {}
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

  // A `receive` from an older load neither mutates nor sends, so a slow `initialize`
  // cannot answer the next page.
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

  const authorized = (params: { sessionKey?: unknown } | undefined): boolean =>
    currentSessionKey !== null && params?.sessionKey === currentSessionKey;

  const unauthorized = (id: string | undefined): void =>
    respondOrDrop(id, ErrorCode.unauthorized, 'Unauthorized', { reason: 'missing_session_key' });

  // Settles a request; a result or error from an older load is dropped.
  const answer = async (
    id: string | undefined,
    myGen: number,
    run: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      const result = await run();
      if (myGen !== generation) return;
      if (id !== undefined) sendResult(id, result);
    } catch (e) {
      if (myGen !== generation) return;
      // The page picks its error screen from the code; an unknown code reads as "Update needed".
      const { code, message } = failure(e);
      respondOrDrop(id, code, message);
    }
  };

  type Params = Record<string, unknown>;
  type Route = (params: Params, id: string | undefined, myGen: number) => void | Promise<void>;

  const anyParams = (_v: unknown): _v is Params => true;

  // Answers with the handler's result.
  const call =
    <P>(accepts: (v: unknown) => v is P, run: (params: P) => Promise<unknown>): Route =>
    (params, id, myGen) => {
      if (!accepts(params)) return respondOrDrop(id, ErrorCode.invalidParams, 'Invalid params');
      return answer(id, myGen, () => run(params));
    };

  // Answers nothing, even when the page sent an id.
  const notify =
    <P>(accepts: (v: unknown) => v is P, run: (params: P) => void): Route =>
    (params, id) => {
      if (!accepts(params)) return respondOrDrop(id, ErrorCode.invalidParams, 'Invalid params');
      run(params);
    };

  // A Map, so a method named `constructor` or `__proto__` finds no route.
  const routes = new Map<string, Route>([
    [Method.refreshIdentity, call(anyParams, () => handlers.refreshIdentity())],
    [Method.openUrl, call(isOpenUrlParams, (p) => handlers.openUrl(p.url).then(() => null))],
    [Method.ready, notify(anyParams, () => handlers.onReady())],
    [Method.close, notify(anyParams, () => handlers.onClose())],
    [
      Method.identityError,
      notify(isIdentityErrorParams, (p) => handlers.onIdentityError(p.reason, p.message)),
    ],
    [Method.backHandling, notify(isBackHandlingParams, (p) => handlers.onBackHandling(p.active))],
    [
      Method.unreadCountChanged,
      notify(isUnreadCountParams, (p) => handlers.onUnreadCountChanged(p.count)),
    ],
  ]);

  const initialize = async (id: string, params: Params, myGen: number): Promise<void> => {
    if (!isInitializeParams(params)) {
      sendError(id, ErrorCode.invalidParams, 'Invalid params');
      return;
    }
    if (initializeLatch) {
      sendError(id, ErrorCode.invalidRequest, 'initialize already completed for this page load');
      return;
    }
    initializeLatch = true; // set before the await so a concurrent initialize is rejected
    await answer(id, myGen, async () => {
      const result = await handlers.initialize({ protocolVersion: params.protocolVersion });
      if (myGen === generation) currentSessionKey = result.sessionKey;
      return result;
    });
  };

  const receive = async (raw: string): Promise<void> => {
    const myGen = generation;
    const message = parseInbound(raw);

    if (message === null) {
      respondOrDrop(extractRawId(raw), ErrorCode.invalidRequest, 'Invalid Request');
      return;
    }

    // The page never answers host requests; a response is only checked for the key.
    if (!('method' in message)) {
      if (!authorized(message.params)) unauthorized(message.id);
      return;
    }

    const id = 'id' in message ? message.id : undefined;

    if (message.method === Method.initialize) {
      if (id !== undefined) await initialize(id, message.params, myGen);
      return;
    }

    if (!authorized(message.params)) {
      unauthorized(id);
      return;
    }

    const route = routes.get(message.method);
    if (!route) {
      respondOrDrop(id, ErrorCode.methodNotFound, 'Method not found');
      return;
    }
    await route(message.params, id, myGen);
  };

  // A page that has not handshaked would answer -32001.
  const sendNotification = (method: Method, extra: Params = {}): void => {
    if (currentSessionKey === null) return;
    send(
      JSON.stringify({
        jsonrpc: '2.0',
        method,
        params: { sessionKey: currentSessionKey, ...extra },
      }),
    );
  };

  const resetLoad = (): void => {
    generation += 1;
    initializeLatch = false;
    currentSessionKey = null;
  };

  return {
    receive,
    sendBack: () => sendNotification(Method.back),
    sendShow: () => sendNotification(Method.show),
    sendHide: () => sendNotification(Method.hide),
    sendOpen: (threadId) => sendNotification(Method.open, { threadId }),
    resetLoad,
    sessionKey: () => currentSessionKey,
  };
};
