import { sha256 } from 'js-sha256';

// STANDS IN FOR YOUR SERVER. Never ship this: the identity secret in a bundle lets anyone
// forge tokens. A real app mints behind its own authenticated endpoint.

/** Hermes does not guarantee `TextEncoder`. */
const utf8 = (text: string): number[] => {
  const out: number[] = [];
  for (const char of text) {
    let code = char.codePointAt(0) ?? 0;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else {
      out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f));
      out.push(0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
    code = 0;
  }
  return out;
};

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unpadded base64url; Hermes does not guarantee `btoa`. */
const b64url = (bytes: ArrayLike<number>): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const left = bytes.length - i;
    out += ALPHABET.charAt(a >> 2) + ALPHABET.charAt(((a & 3) << 4) | (b >> 4));
    if (left > 1) out += ALPHABET.charAt(((b & 15) << 2) | (c >> 6));
    if (left > 2) out += ALPHABET.charAt(c & 63);
  }
  return out;
};

const segment = (value: unknown): string => b64url(utf8(JSON.stringify(value)));

const RESERVED = new Set(['sub', 'iat', 'exp', 'aud']);

export type MintOptions = {
  readonly sub: string;
  readonly claims?: Readonly<Record<string, string>>;
  readonly ttlSeconds?: number;
};

export const mintIdentityToken = (secret: string, options: MintOptions): string => {
  const now = Math.floor(Date.now() / 1000);
  const extra = Object.fromEntries(
    Object.entries(options.claims ?? {}).filter(
      ([name, value]) => !RESERVED.has(name) && value !== '',
    ),
  );
  const head = segment({ alg: 'HS256', typ: 'JWT' });
  const body = segment({
    ...extra,
    sub: options.sub,
    aud: 'mentiora',
    iat: now,
    exp: now + (options.ttlSeconds ?? 300),
  });
  const sig = new Uint8Array(sha256.hmac.arrayBuffer(secret, `${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
};

const ROUND_TRIP_MS = 120;

/** A real handler takes `sub` from the caller's session, never from the client. */
export const issueIdentityToken = async (secret: string, options: MintOptions): Promise<string> => {
  await new Promise((resolve) => setTimeout(resolve, ROUND_TRIP_MS));
  if (options.sub === '') throw new Error('nobody is signed in');
  return mintIdentityToken(secret, options);
};
