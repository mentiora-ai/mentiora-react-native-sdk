/**
 * Random bytes from the page's WebCrypto, bounded at 2s. React Native has no
 * global WebCrypto, so the host injects a script calling `getRandomValues` in
 * the WebView; the bytes become the session key and the install id.
 * Replies are authenticated by a per-request nonce, not the module-constant
 * tag any frame can spell — chosen bytes mean a chosen session key. The nonce
 * ships inside the injected script, which runs in the main frame only.
 */

export type RandomSource = {
  /** Exactly `count` cryptographically random bytes (callers ask for 16). One
   *  request in flight: a second call while one is pending rejects. */
  bytes: (count: number) => Promise<Uint8Array>;
  /** Called by the component's onMessage router BEFORE the JSON-RPC parser. */
  acceptReply: (raw: string) => boolean;
  /** Invalidates the parked resolver at a load boundary; left pending, it
   *  fails the replacement page's `initialize` `-32603` on "already in flight". */
  reset: () => void;
};

export const RANDOM_REPLY_TAG = '__mentiora_random__';

let nonceCounter = 0;
/** Per-request, non-repeating, unpredictable from the page side. Not exported. */
const newNonce = (): string =>
  `${++nonceCounter}.${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

export type RandomDeps = {
  inject: (script: string) => void;
  timeoutMs?: number; // default 2000
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  globalCrypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
};

export const createRandomSource = (deps: RandomDeps): RandomSource => {
  const timeoutMs = deps.timeoutMs ?? 2000;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((h: unknown) => clearTimeout(h as Parameters<typeof clearTimeout>[0]));
  // ponytail: injected seam for a host polyfill, never sniffed from
  // `globalThis` — Node's test runner has `crypto` and would skip the inject.
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
    // The nonce is the whole authentication; anything else — a stale reply
    // included — falls through untouched to the JSON-RPC parser.
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

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export const toBase64Url = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) {
      out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    }
    if (b2 !== undefined) {
      out += BASE64URL_ALPHABET[b2 & 0x3f];
    }
  }
  return out;
};
