/**
 * Random bytes sourced from the page's WebCrypto, bounded at 2s (design.md
 * §2.1). React Native has no global WebCrypto and `Math.random` is not a
 * CSPRNG, so the host injects a script that calls `crypto.getRandomValues`
 * inside the WebView and posts the bytes back. Those bytes become the
 * bridge session key (16 bytes) and, on first launch, the install id
 * (16 more).
 *
 * `globalCrypto` is an injectable seam for a host app that has polyfilled
 * WebCrypto (or for tests) — it is not a production path in React Native,
 * which has no global `crypto`. When present, it skips the round trip
 * entirely.
 *
 * One request in flight at a time: `bytes()` is only ever called during the
 * handshake, so a second call while one is pending rejects rather than
 * queuing — there is no general request/response correlator here.
 */

export type RandomSource = {
  /** Resolves exactly `count` cryptographically random bytes. Callers ask for 16 at a
   *  time: once for the session key, once more for an install id if one is needed. */
  bytes: (count: number) => Promise<Uint8Array>;
  /** Called by the component's onMessage router BEFORE the JSON-RPC parser. */
  acceptReply: (raw: string) => boolean;
};

export const RANDOM_REPLY_TAG = '__mentiora_random__';

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
  // ponytail: no ambient-global sniffing here — React Native has no global
  // `crypto`, and this codebase's Node-based test runner does (WebCrypto has
  // been a Node global since v19), so reaching for `globalThis.crypto` would
  // silently take the fast path in tests that never pass `globalCrypto` and
  // expect the inject path. Callers that have a polyfill pass it explicitly.
  const globalCrypto = deps.globalCrypto;

  let pending: {
    resolve: (b: Uint8Array) => void;
    reject: (e: Error) => void;
    timer: unknown;
    count: number;
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
      const timer = setTimer(() => {
        pending = null;
        reject(new Error('random bytes request timed out'));
      }, timeoutMs);
      pending = { resolve, reject, timer, count };

      const script = `(function(){try{
  var n = ${JSON.stringify(count)};
  var a = new Uint8Array(n);
  crypto.getRandomValues(a);
  window.ReactNativeWebView.postMessage(JSON.stringify({tag:${JSON.stringify(RANDOM_REPLY_TAG)},bytes:Array.from(a)}));
}catch(e){
  window.ReactNativeWebView.postMessage(JSON.stringify({tag:${JSON.stringify(RANDOM_REPLY_TAG)},error:String((e&&e.message)||e)}));
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
    pending = null;
    if (current) clearTimer(current.timer);

    if (!current) return true;

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

  return { bytes, acceptReply };
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
