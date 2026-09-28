/**
 * React Native has no global WebCrypto, so bytes come from a script injected into the
 * WebView's main frame. Replies are authenticated by a per-request nonce: any frame can
 * spell the tag, and chosen bytes would mean a chosen session key.
 */
import { clearTimer as defaultClearTimer, setTimer as defaultSetTimer } from './timers.js';

export type RandomSource = {
  /** A second call while one is pending rejects. */
  bytes: (count: number) => Promise<Uint8Array>;
  /** Must run before the JSON-RPC parser in the onMessage router. */
  acceptReply: (raw: string) => boolean;
  /** Call at a load boundary, or the next page's `initialize` fails "already in flight". */
  reset: () => void;
};

export const RANDOM_REPLY_TAG = '__mentiora_random__';

let nonceCounter = 0;
/** Must not repeat or be predictable from the page side. */
const newNonce = (): string =>
  `${++nonceCounter}.${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

export type RandomDeps = {
  inject: (script: string) => void;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  globalCrypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
};

export const createRandomSource = (deps: RandomDeps): RandomSource => {
  const timeoutMs = deps.timeoutMs ?? 2000;
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const clearTimer = deps.clearTimer ?? defaultClearTimer;
  // Injected for a host polyfill. Not read from `globalThis`: Node's
  // test runner has `crypto` and would skip the inject path.
  const globalCrypto = deps.globalCrypto;

  let pending: {
    resolve: (b: Uint8Array) => void;
    reject: (e: Error) => void;
    timer: unknown;
    count: number;
    nonce: string;
  } | null = null;

  const bytes = (count: number): Promise<Uint8Array> => {
    if (globalCrypto?.getRandomValues) {
      try {
        const a = new Uint8Array(count);
        globalCrypto.getRandomValues(a);
        return Promise.resolve(a);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    }

    if (pending) {
      return Promise.reject(new Error('random bytes request already in flight'));
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      const nonce = newNonce();
      const timer = setTimer(() => {
        pending = null;
        reject(new Error('random bytes request timed out'));
      }, timeoutMs);
      pending = { resolve, reject, timer, count, nonce };

      const script = `(function(){var t=${JSON.stringify(RANDOM_REPLY_TAG)},k=${JSON.stringify(nonce)};try{
  var n = ${JSON.stringify(count)};
  var a = new Uint8Array(n);
  crypto.getRandomValues(a);
  window.ReactNativeWebView.postMessage(JSON.stringify({tag:t,nonce:k,bytes:Array.from(a)}));
}catch(e){
  window.ReactNativeWebView.postMessage(JSON.stringify({tag:t,nonce:k,error:String((e&&e.message)||e)}));
}})();true;`;
      deps.inject(script);
    });
  };

  const acceptReply = (raw: string): boolean => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const obj = parsed as Record<string, unknown>;
    if (obj.tag !== RANDOM_REPLY_TAG) return false;

    const current = pending;
    // A nonce mismatch, including a stale reply, falls through to the JSON-RPC parser.
    if (!current || obj.nonce !== current.nonce) return false;

    pending = null;
    clearTimer(current.timer);

    if (typeof obj.error === 'string') {
      current.reject(new Error(obj.error));
      return true;
    }

    const isByte = (n: unknown): n is number =>
      typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255;

    if (
      !Array.isArray(obj.bytes) ||
      obj.bytes.length !== current.count ||
      !obj.bytes.every(isByte)
    ) {
      current.reject(new Error('random bytes reply malformed'));
      return true;
    }

    current.resolve(new Uint8Array(obj.bytes as number[]));
    return true;
  };

  const reset = (): void => {
    const current = pending;
    if (!current) return;
    pending = null;
    clearTimer(current.timer);
    current.reject(new Error('random bytes request superseded by a load boundary'));
  };

  return { bytes, acceptReply, reset };
};
