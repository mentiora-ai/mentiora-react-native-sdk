/**
 * Identity: the token the server uses to decide who the user is; none means
 * anonymous, keyed to the install id. `initial()` runs within the page's 8s
 * handshake, `refresh()` within its 30s request timeout. A boot failure on an
 * install flagged by `wasSignedInKey` throws. Only that flag is persisted.
 */

import { type RetryPolicy, retry } from './retry.js';
import type { MentioraIdentity, MentioraStorage } from './types.js';

/** Shared by every provider a runtime entry owns, so a discarded provider's
 *  mint cannot write `wasSignedIn` onto a logged-out install (boot deadlock). */
export type LogoutEpoch = { n: number };

export type IdentityProvider = {
  /** Boot: the token for InitializeResult, or undefined for anonymous. Throws
   *  IdentityUnavailable when the fetch fails on a previously signed-in install. */
  initial: () => Promise<string | undefined>;
  /** mentiora/refreshIdentity. Throws IdentityUnavailable to produce -32002. */
  refresh: () => Promise<string>;
  /** Drops the cached token and the wasSignedIn flag. Called by logout. */
  clear: () => Promise<void>;
};

export class IdentityUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityUnavailable';
  }
}

export const wasSignedInKey = (embedKey: string): string => `mentiora.wasSignedIn.${embedKey}`;

export const REFRESH_BEFORE_EXPIRY_MS = 60_000;
export const REUSE_FLOOR_MS = 300_000;

export const REFRESH_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  baseMs: 1000,
  capMs: 8000,
  totalBudgetMs: 8000,
};
export const BOOT_RETRY_POLICY: RetryPolicy = {
  attempts: 2,
  baseMs: 500,
  capMs: 2000,
  totalBudgetMs: 4000,
};

// Hand-rolled: Hermes guarantees neither Buffer nor atob.
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL_LOOKUP: Record<string, number> = {};
for (let i = 0; i < BASE64URL_ALPHABET.length; i++) {
  BASE64URL_LOOKUP[BASE64URL_ALPHABET[i] as string] = i;
}

const base64UrlToBytes = (s: string): Uint8Array => {
  const clean = s.replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const val = BASE64URL_LOOKUP[ch];
    if (val === undefined) throw new Error('invalid base64url character');
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
};

const bytesToUtf8 = (bytes: Uint8Array): string => {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++] as number;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if ((b0 & 0xe0) === 0xc0) {
      const b1 = bytes[i++] as number;
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
    } else if ((b0 & 0xf0) === 0xe0) {
      const b1 = bytes[i++] as number;
      const b2 = bytes[i++] as number;
      out += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
    } else if ((b0 & 0xf8) === 0xf0) {
      const b1 = bytes[i++] as number;
      const b2 = bytes[i++] as number;
      const b3 = bytes[i++] as number;
      const cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      out += String.fromCodePoint(cp);
    } else {
      throw new Error('invalid utf-8 byte');
    }
  }
  return out;
};

type JwtPayload = { exp?: unknown; iat?: unknown };

/** Payload only, unverified — the signature is the server's job. */
const decodePayload = (jwt: string): JwtPayload | null => {
  try {
    const segment = jwt.split('.')[1];
    if (!segment) return null;
    const parsed: unknown = JSON.parse(bytesToUtf8(base64UrlToBytes(segment)));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as JwtPayload;
  } catch {
    return null;
  }
};

export const decodeExp = (jwt: string): number | null => {
  const payload = decodePayload(jwt);
  return typeof payload?.exp === 'number' ? payload.exp : null;
};

const extractToken = (data: unknown): string => {
  if (typeof data === 'string') return data;
  if (data !== null && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj.token === 'string') return obj.token;
    if (typeof obj.identityToken === 'string') return obj.identityToken;
  }
  throw new Error('identity response did not contain a token');
};

const isFetcherShape = (identity: MentioraIdentity): boolean => 'endpoint' in identity;

export const createIdentityProvider = (deps: {
  identity?: MentioraIdentity;
  embedKey: string;
  storage: MentioraStorage;
  fetchImpl?: typeof fetch;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  warn?: (m: string) => void;
  /** Owned by the runtime entry; see `LogoutEpoch`. */
  epoch?: LogoutEpoch;
}): IdentityProvider => {
  const { identity, embedKey, storage, warn } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((h: unknown) => clearTimeout(h as Parameters<typeof clearTimeout>[0]));
  const now = deps.now ?? Date.now;

  let cache: { token: string; expMs: number } | undefined;

  // Bumped synchronously in `clear()`. A mint captures it on entry and re-checks
  // before each write and before returning; a mismatch drops the token.
  const epoch = deps.epoch ?? { n: 0 };

  // Owns the stored marker, so a stale mint only undoes its own write.
  let markerEpoch = -1;

  const isFresh = (floorMs: number): boolean =>
    cache !== undefined && now() < cache.expMs - floorMs;

  // `retry` bounds only the delays between attempts, and the widget's handshake
  // watchdog is paused during the boot mint, so an endpoint that never answers
  // would hang boot without this timeout. Hermes lacks `AbortSignal.timeout`.
  const fetchRawToken = async (id: MentioraIdentity, timeoutMs: number): Promise<string> => {
    if ('getToken' in id) return await id.getToken();

    const headers = id.headers ? await id.headers() : undefined;
    const body = id.body ? await id.body() : undefined;
    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(id.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`identity endpoint responded with ${res.status}`);
      return extractToken(await res.json());
    } finally {
      clearTimer(timer);
    }
  };

  const mintToken = async (policy: RetryPolicy, id: MentioraIdentity): Promise<string> => {
    const myGen = epoch.n;
    const cleared = (): boolean => epoch.n !== myGen;

    let raw: string;
    try {
      raw = await retry(
        () => fetchRawToken(id, policy.totalBudgetMs),
        policy,
        deps.sleep,
        deps.random,
      );
    } catch (err) {
      throw new IdentityUnavailable(err instanceof Error ? err.message : 'identity fetch failed');
    }

    if (cleared()) throw new IdentityUnavailable('identity cleared while the token was in flight');

    const payload = decodePayload(raw);
    const exp = typeof payload?.exp === 'number' ? payload.exp : null;
    const iat = typeof payload?.iat === 'number' ? payload.iat : null;
    if (exp !== null && iat !== null && exp - iat > 3600) {
      warn?.('mentiora identity: token exp - iat exceeds 3600s and will be rejected by the mint');
    }
    // A token with no readable exp is used but never cached.
    cache = exp !== null ? { token: raw, expMs: exp * 1000 } : undefined;

    try {
      // Re-checked after the await: a marker on a logged-out install deadlocks.
      markerEpoch = myGen;
      await storage.setItem(wasSignedInKey(embedKey), '1');
      if (cleared() && markerEpoch === myGen) {
        await storage.removeItem(wasSignedInKey(embedKey));
      }
    } catch {
      // A failed flag write must not fail a boot that already has a token.
    }

    if (cleared()) {
      // Only our own token, never a newer mint's.
      if (cache?.token === raw) cache = undefined;
      throw new IdentityUnavailable('identity cleared while the token was in flight');
    }

    return raw;
  };

  const initial = async (): Promise<string | undefined> => {
    if (!identity) {
      // Before the anonymous shortcut: booting ahead of the host's auth layer
      // must not demote a signed-in install to anonymous.
      const wasSignedIn = await storage.getItem(wasSignedInKey(embedKey));
      if (wasSignedIn) {
        throw new IdentityUnavailable(
          'this install was signed in before, but no identity is configured',
        );
      }
      return undefined;
    }

    if (isFetcherShape(identity) && isFresh(REFRESH_BEFORE_EXPIRY_MS) && cache) {
      return cache.token;
    }

    try {
      return await mintToken(BOOT_RETRY_POLICY, identity);
    } catch (err) {
      if (!(err instanceof IdentityUnavailable)) throw err;
      const wasSignedIn = await storage.getItem(wasSignedInKey(embedKey));
      if (wasSignedIn) throw err;
      return undefined;
    }
  };

  const refresh = async (): Promise<string> => {
    if (!identity) throw new IdentityUnavailable('no identity configured');

    if (isFetcherShape(identity) && isFresh(REUSE_FLOOR_MS) && cache) {
      return cache.token;
    }

    return await mintToken(REFRESH_RETRY_POLICY, identity);
  };

  const clear = async (): Promise<void> => {
    // Before any await, so an acquisition that resumes later sees it.
    epoch.n += 1;
    cache = undefined;
    await storage.removeItem(wasSignedInKey(embedKey));
  };

  return { initial, refresh, clear };
};
