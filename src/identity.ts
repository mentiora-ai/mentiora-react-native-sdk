import { fromBase64Url } from './base64url.js';
import { backoff, type RetryPolicy, retry } from './retry.js';
import { clearTimer as defaultClearTimer, setTimer as defaultSetTimer } from './timers.js';
import type { MentioraIdentity, MentioraStorage } from './types.js';

/** Shared across a runtime entry's providers, so a discarded provider's mint cannot
 *  write `wasSignedIn` onto a logged-out install (boot deadlock). */
export type LogoutEpoch = { n: number };

export type IdentityProvider = {
  /** Undefined means anonymous. Throws IdentityUnavailable when the fetch fails on a
   *  previously signed-in install. Must finish within the page's 8s handshake. */
  initial: () => Promise<string | undefined>;
  /** IdentityUnavailable maps to -32002. */
  refresh: () => Promise<string>;
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

export const REFRESH_RETRY_POLICY: RetryPolicy = backoff(3);
export const BOOT_RETRY_POLICY: RetryPolicy = {
  attempts: 2,
  baseMs: 500,
  capMs: 2000,
  totalBudgetMs: 4000,
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

type JwtClaims = { exp: number | null; iat: number | null };

const NO_CLAIMS: JwtClaims = { exp: null, iat: null };

const numberOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** Payload only, unverified — the signature is the server's job. */
export const decodeClaims = (jwt: string): JwtClaims => {
  try {
    const segment = jwt.split('.')[1];
    if (!segment) return NO_CLAIMS;
    const parsed: unknown = JSON.parse(bytesToUtf8(fromBase64Url(segment)));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return NO_CLAIMS;
    const { exp, iat } = parsed as Record<string, unknown>;
    return { exp: numberOrNull(exp), iat: numberOrNull(iat) };
  } catch {
    return NO_CLAIMS;
  }
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
  epoch?: LogoutEpoch;
}): IdentityProvider => {
  const { identity, embedKey, storage, warn } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const clearTimer = deps.clearTimer ?? defaultClearTimer;
  const now = deps.now ?? Date.now;

  let cache: { token: string; expMs: number } | undefined;

  const epoch = deps.epoch ?? { n: 0 };

  // Owns the stored marker, so a stale mint only undoes its own write.
  let markerEpoch = -1;

  // Only the fetcher shape is cached: a `getToken` callback is asked every time.
  const cachedToken = (floorMs: number): string | undefined =>
    identity && isFetcherShape(identity) && cache && now() < cache.expMs - floorMs
      ? cache.token
      : undefined;

  const wasSignedIn = async (): Promise<boolean> =>
    Boolean(await storage.getItem(wasSignedInKey(embedKey)));

  // The handshake watchdog is paused during the boot mint, so a silent endpoint would
  // hang boot without this timeout. Hermes lacks `AbortSignal.timeout`.
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

    const { exp, iat } = decodeClaims(raw);
    if (exp !== null && iat !== null && exp - iat > 3600) {
      warn?.('mentiora identity: token exp - iat exceeds 3600s and will be rejected by Mentiora');
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
      // Booting ahead of the host's auth layer must not demote a signed-in install.
      if (await wasSignedIn()) {
        throw new IdentityUnavailable(
          'this install was signed in before, but no identity is configured',
        );
      }
      return undefined;
    }

    const cached = cachedToken(REFRESH_BEFORE_EXPIRY_MS);
    if (cached !== undefined) return cached;

    try {
      return await mintToken(BOOT_RETRY_POLICY, identity);
    } catch (err) {
      if (!(err instanceof IdentityUnavailable) || (await wasSignedIn())) throw err;
      return undefined;
    }
  };

  const refresh = async (): Promise<string> => {
    if (!identity) throw new IdentityUnavailable('no identity configured');

    return cachedToken(REUSE_FLOOR_MS) ?? (await mintToken(REFRESH_RETRY_POLICY, identity));
  };

  const clear = async (): Promise<void> => {
    // Before any await, so an in-flight mint that resumes later sees it.
    epoch.n += 1;
    cache = undefined;
    await storage.removeItem(wasSignedInKey(embedKey));
  };

  return { initial, refresh, clear };
};
