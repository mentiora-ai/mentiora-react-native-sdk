// Not `new URL()` (RN's throws) or `originWhitelist` (a prefix match:
// `https://a.ai` accepts `https://a.ai.evil.com`). All checks fail closed.

// biome-ignore lint/suspicious/noControlCharactersInRegex: a tab or NUL inside 'https:' must not slip past schemeOf
const clean = (url: string): string => url.replace(/[\u0000-\u0020\u007f]/g, '');

const SCHEME_RE = /^([a-zA-Z][a-zA-Z\d+\-.]*):/;

const AUTHORITY_RE = /^(https?):\/\/([^/?#]+)/i;

// `https://a.ai@evil.com` is really `evil.com`, and `\` is a WHATWG separator.
const FORBIDDEN_IN_AUTHORITY = /[\\@]/;

const ALLOWED_SCHEMES: readonly string[] = ['https:', 'mailto:', 'tel:'];

const MAX_EXTERNAL_URL_LENGTH = 2048;

export const schemeOf = (url: string): string | null => {
  const m = SCHEME_RE.exec(clean(url));
  return m ? `${(m[1] as string).toLowerCase()}:` : null;
};

export const isAllowedExternal = (url: string): boolean => {
  if (url.length > MAX_EXTERNAL_URL_LENGTH) return false;
  const scheme = schemeOf(url);
  return scheme !== null && ALLOWED_SCHEMES.includes(scheme);
};

export const originOf = (url: string): string | null => {
  const m = AUTHORITY_RE.exec(clean(url));
  if (!m) return null;
  const authority = m[2] as string;
  if (FORBIDDEN_IN_AUTHORITY.test(authority)) return null;
  const scheme = (m[1] as string).toLowerCase();
  const host = authority.toLowerCase();
  return `${scheme}://${host}`;
};

/** True when `b` is `a` with only its fragment changed; `b` must contain `#`. */
export const isSameDocument = (a: string, b: string): boolean =>
  b.includes('#') && a.split('#')[0] === b.split('#')[0];

export const isSameOrigin = (url: string, widgetOrigin: string): boolean => {
  const a = originOf(url);
  const b = originOf(widgetOrigin);
  return a !== null && b !== null && a === b;
};
