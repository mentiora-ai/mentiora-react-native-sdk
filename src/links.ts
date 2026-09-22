/**
 * Link routing, both directions fail closed. `isSameOrigin` gates same-WebView
 * navigation, which inherits the widget origin's session; `isAllowedExternal`
 * gates `Linking.openURL`, where a false accept hands `javascript:` or `file:`
 * to the OS. Never `new URL()` (RN's throws) or `originWhitelist` (a prefix
 * match, so `https://a.ai` accepts `https://a.ai.evil.com`).
 */

// The space is the \u0020 escape, not a literal, so no formatter eats it.
// biome-ignore lint/suspicious/noControlCharactersInRegex: a tab or NUL inside 'https:' must not slip past schemeOf
const clean = (url: string): string => url.replace(/[\u0000-\u0020\u007f]/g, '');

const SCHEME_RE = /^([a-zA-Z][a-zA-Z\d+\-.]*):/;

const AUTHORITY_RE = /^(https?):\/\/([^/?#]+)/i;

// `@` or `\` anywhere in the authority voids the match rather than truncating:
// `https://a.ai@evil.com` is really `evil.com`, `\` is a WHATWG separator, and
// truncating at either would read both as SAME origin.
const FORBIDDEN_IN_AUTHORITY = /[\\@]/;

export const ALLOWED_SCHEMES = ['https:', 'mailto:', 'tel:'] as const;

const MAX_EXTERNAL_URL_LENGTH = 2048;

export const schemeOf = (url: string): string | null => {
  const m = SCHEME_RE.exec(clean(url));
  return m ? `${(m[1] as string).toLowerCase()}:` : null;
};

export const isAllowedExternal = (url: string): boolean => {
  if (url.length > MAX_EXTERNAL_URL_LENGTH) return false;
  const scheme = schemeOf(url);
  return scheme !== null && (ALLOWED_SCHEMES as readonly string[]).includes(scheme);
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

/** Same document: `b` is `a` with only its fragment changed, and the TARGET
 *  must carry one (`#` alone counts). Missing a real navigation answers the
 *  new document's `initialize` -32600; calling `/chat` -> `/chat#t` a boundary
 *  drops a live session key and every page call takes -32001. Raw strings. */
export const isSameDocument = (a: string, b: string): boolean =>
  b.includes('#') && a.split('#')[0] === b.split('#')[0];

export const isSameOrigin = (url: string, widgetOrigin: string): boolean => {
  const a = originOf(url);
  const b = originOf(widgetOrigin);
  return a !== null && b !== null && a === b;
};
