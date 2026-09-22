/**
 * Identity: the token (or lack of one) the widget's server uses to decide
 * who the user is (design.md §2.3). A token means a signed-in user; no
 * token means an anonymous user keyed to the install id.
 *
 * Two rules make this more than "fetch a JWT":
 *
 * - Boot (`initial()`) runs *inside* the page's 8s handshake, of which
 *   Task 5's random-bytes step may already have spent 2s. It gets the short
 *   `BOOT_RETRY_POLICY` ladder so a failure still leaves time to answer the
 *   handshake. `refresh()` (`mentiora/refreshIdentity`) is bounded by the
 *   page's own 30s request timeout instead, so it gets the full
 *   `REFRESH_RETRY_POLICY` ladder.
 * - A failed boot must never quietly demote a signed-in user to a fresh
 *   anonymous one. `wasSignedInKey(embedKey)` in `storage` records that this
 *   install has held a token before; a boot failure on a flagged install
 *   throws `IdentityUnavailable` (failing the handshake) instead of
 *   answering anonymously and orphaning that user's threads.
 *
 * The token itself never touches storage and is never logged — only the
 * `wasSignedIn` boolean is persisted.
 */

import { type RetryPolicy, retry } from './retry.js';
import type { MentioraIdentity, MentioraStorage } from './types.js';

export type IdentityProvider = {
  /**
   * Boot: the token to put in InitializeResult, or undefined for anonymous.
   * Throws IdentityUnavailable when the fetch fails AND this install was signed in before —
   * the caller then fails the handshake and shows the error surface, because answering
   * without a token would demote a signed-in user to a fresh anonymous one (§2.3).
   */
  initial: () => Promise<string | undefined>;
  /** mentiora/refreshIdentity. Throws IdentityUnavailable to produce -32002. */
  refresh: () => Promise<string>;
  /** Drops the cached token AND the wasSignedIn flag. Called by logout (Task 7a). */
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

// base64url decode, written by hand (mirrors random.ts's encoder) rather than
// via Buffer/atob: React Native's Hermes has neither guaranteed, and this is
// the only place identity.ts needs one.
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

/** Decodes segment 1 of a JWT without verifying anything — a signature
 *  check is the server's job. Returns null for anything it cannot read. */
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
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  warn?: (m: string) => void;
}): IdentityProvider => {
  const { identity, embedKey, storage, warn } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  // The token lives only here, in memory, for this provider's lifetime.
  // It is never handed to `storage`.
  let cache: { token: string; expMs: number } | undefined;

  // Bumped SYNCHRONOUSLY at the top of `clear()` (external review, B2). An
  // acquisition is a long chain of awaits — the retry ladder, `fetch`, a retry
  // sleep, response parsing — and a `logout()` landing anywhere inside it used
  // to be undone the moment the chain resumed: `mintToken` wrote `cache` and
  // the `wasSignedIn` marker unconditionally, so the next boot reused a
  // pre-logout token. Every acquisition captures this on entry and re-checks
  // it before each write and before returning; a mismatch means the token it
  // is holding belongs to a user who has since logged out, and it is dropped
  // rather than published.
  let generation = 0;

  const isFresh = (floorMs: number): boolean =>
    cache !== undefined && now() < cache.expMs - floorMs;

  const fetchRawToken = async (id: MentioraIdentity): Promise<string> => {
    if ('getToken' in id) return await id.getToken();

    const headers = id.headers ? await id.headers() : undefined;
    const body = id.body ? await id.body() : undefined;
    const res = await fetchImpl(id.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`identity endpoint responded with ${res.status}`);
    return extractToken(await res.json());
  };

  const mintToken = async (policy: RetryPolicy, id: MentioraIdentity): Promise<string> => {
    const myGen = generation;
    const cleared = (): boolean => generation !== myGen;

    let raw: string;
    try {
      raw = await retry(() => fetchRawToken(id), policy, deps.sleep, deps.random);
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
    // A token with no readable exp is used but never cached (§ decodeExp).
    cache = exp !== null ? { token: raw, expMs: exp * 1000 } : undefined;

    try {
      // Re-checked after the await too: `setItem` can resolve after a logout
      // that started while it was pending, and a marker set on a logged-out
      // install is a boot deadlock (`initial()` throws on it forever).
      await storage.setItem(wasSignedInKey(embedKey), '1');
      if (cleared()) await storage.removeItem(wasSignedInKey(embedKey));
    } catch {
      // A failed flag write must not fail a successful boot/refresh — the
      // caller already has a token. Nothing else in this function swallows.
    }

    if (cleared()) {
      cache = undefined;
      throw new IdentityUnavailable('identity cleared while the token was in flight');
    }

    return raw;
  };

  const initial = async (): Promise<string | undefined> => {
    if (!identity) return undefined;

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
    generation += 1;
    cache = undefined;
    await storage.removeItem(wasSignedInKey(embedKey));
  };

  return { initial, refresh, clear };
};
