/**
 * Link routing: what the WebView is allowed to navigate to inline, and what it may hand
 * to the OS. Both fail closed.
 *
 * `isSameOrigin` gates same-WebView navigation, which inherits the widget origin's
 * session -- a false accept here is credential exfiltration. `isAllowedExternal` gates
 * `Linking.openURL`, where a false accept hands `javascript:`, `file:` or `intent:` to
 * the OS.
 *
 * Never `new URL()`: React Native's global `URL` is not WHATWG-compliant and `.origin`
 * throws through RN 0.80, which is why this file hand-rolls matching instead. Never
 * `originWhitelist`: it is prefix-anchored, so `https://widget.acme.ai` would match
 * `https://widget.acme.ai.evil.com`.
 */

// Strips every C0 control plus DEL so a split scheme (e.g. a tab or NUL inside
// 'https:') can't slip past schemeOf. The range is written with the \u0020 escape for
// the space, not a literal space character, so a formatter can't silently eat it.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional, see above.
const clean = (url: string): string => url.replace(/[\u0000-\u0020\u007f]/g, '');

const SCHEME_RE = /^([a-zA-Z][a-zA-Z\d+\-.]*):/;

// Authority runs up to the first real WHATWG delimiter -- `/`, `?` or `#`. `i` on the
// scheme so 'HTTPS://' matches before normalisation.
const AUTHORITY_RE = /^(https?):\/\/([^/?#]+)/i;

// `@` and `\` inside that authority both mean "this is not a plain host": `@` makes
// everything before it userinfo (`https://widget.acme.ai@evil.com` -- the real host is
// `evil.com`), and `\` is a separator for special schemes under WHATWG (so a naive
// scanner reading up to it, or reading past it, disagrees with what an actual browser
// engine resolves). Rather than emulate WHATWG's own host/path split for `\` -- which is
// exactly the `new URL()` behaviour this file is banned from using -- any `@` or `\`
// anywhere in the authority voids the match instead of silently truncating it. A
// silent-truncation reading (stop the character class at `@`/`\`) would make BOTH tricks
// capture a host string identical to the real widget host and read as SAME origin --
// the opposite of "fail closed". Denying outright is the safe answer either way.
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

/** Same document, i.e. `b` is `a` with only its fragment changed.
 *
 *  `/chat` -> `/chat#thread` is not a load boundary: the document and its
 *  sandbox iframe are still alive, so treating it as one drops a valid session
 *  key and reopens the keyless `initialize` latch, after which every page call
 *  takes -32001 and the watchdog reloads a healthy page.
 *
 *  The TARGET must actually carry a fragment. The HTML navigate algorithm is
 *  fragment-only iff the destination's fragment is non-null and the two URLs
 *  are otherwise equal, so `/chat` -> `/chat` (a reload, or a link back to the
 *  current path) and `/chat#t` -> `/chat` (fragment removal) are both full
 *  document navigations. Reading either as "same document" leaves the new
 *  document's `initialize` answered -32600 and the widget blank for 8s until
 *  the watchdog reloads it. `#` alone counts: an empty fragment is still
 *  non-null.
 *
 *  Raw string comparison, deliberately: `clean()` would let two genuinely
 *  different URLs compare equal, and an over-eager "same document" is the
 *  dangerous direction. */
export const isSameDocument = (a: string, b: string): boolean =>
  b.includes('#') && a.split('#')[0] === b.split('#')[0];

export const isSameOrigin = (url: string, widgetOrigin: string): boolean => {
  const a = originOf(url);
  const b = originOf(widgetOrigin);
  return a !== null && b !== null && a === b;
};
