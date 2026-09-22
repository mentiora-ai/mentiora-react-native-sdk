import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAllowedExternal, isSameDocument, isSameOrigin, originOf, schemeOf } from './links.js';

test('allows exactly https, mailto and tel', () => {
  assert.equal(isAllowedExternal('https://example.com/a'), true);
  assert.equal(isAllowedExternal('mailto:a@b.com'), true);
  assert.equal(isAllowedExternal('tel:+441234'), true);
  for (const bad of [
    'http://e.com',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'intent://scan#Intent;scheme=zxing;end',
    'data:text/html,<b>',
    'sms:+44',
  ]) {
    assert.equal(isAllowedExternal(bad), false, bad);
  }
});

test('strips C0 and whitespace so a split scheme cannot slip past', () => {
  assert.equal(isAllowedExternal('\tjava\nscript:alert(1)'), false);
  assert.equal(isAllowedExternal('  https://example.com'), true);
  assert.equal(schemeOf('HTTPS://EXAMPLE.COM'), 'https:');
});

test('a scheme-relative or scheme-less url is denied', () => {
  assert.equal(isAllowedExternal('//evil.com'), false);
  assert.equal(isAllowedExternal('/relative'), false);
});

test('origin comparison is exact and case-insensitive on the host', () => {
  const origin = 'https://widget.acme.mentiora.ai';
  assert.equal(isSameOrigin('https://widget.acme.mentiora.ai/h/rn/k', origin), true);
  assert.equal(isSameOrigin('HTTPS://Widget.Acme.Mentiora.AI/h/rn/k', origin), true);
  assert.equal(isSameOrigin('https://widget.acme.mentiora.ai.evil.com/x', origin), false);
  assert.equal(isSameOrigin('https://widget.acme.mentiora.ai@evil.com/x', origin), false);
  assert.equal(isSameOrigin('https://widget.acme.mentiora.ai:8443/x', origin), false);
});

test('a backslash is treated as a separator, as WHATWG does for special schemes', () => {
  assert.equal(
    isSameOrigin('https://widget.acme.mentiora.ai\\.evil.com/', 'https://widget.acme.mentiora.ai'),
    false,
  );
});

test('an over-long url is denied rather than parsed', () => {
  assert.equal(isAllowedExternal(`https://e.com/${'a'.repeat(3000)}`), false);
});

test('isSameOrigin accepts a long, legitimately same-origin url -- no length bound here', () => {
  // The 2048 bound belongs to isAllowedExternal only. A long same-origin url is the
  // widget's own navigation, and applying that bound file-wide would deny it.
  const origin = 'https://widget.acme.mentiora.ai';
  assert.equal(isSameOrigin(`${origin}/h/rn/k?state=${'a'.repeat(3000)}`, origin), true);
});

test('the CONFIGURED origin is normalised too, not just the url', () => {
  // A customer pasting their origin out of a dashboard can capitalise the host. If only
  // the url side were lowercased, every navigation would read cross-origin and the widget
  // would try to open its own pages in the system browser.
  assert.equal(
    isSameOrigin('https://widget.acme.mentiora.ai/h/rn/k', 'HTTPS://Widget.Acme.Mentiora.AI'),
    true,
  );
  assert.equal(
    isSameOrigin('https://widget.acme.mentiora.ai/h/rn/k', 'https://widget.acme.mentiora.ai/'),
    true,
  );
});

test('an unparseable origin denies everything instead of matching everything', () => {
  for (const origin of ['', 'not-a-url', 'https://']) {
    assert.equal(isSameOrigin('https://widget.acme.mentiora.ai/x', origin), false, origin);
  }
  assert.equal(originOf('https://'), null);
});

test('isSameOrigin denies when BOTH sides are unparseable, not only one', () => {
  // originOf('') and originOf('not-a-url') are both null. `a !== null && b !== null`
  // is the guard that stops two nulls from reading as equal (a bare `a === b` would
  // let `null === null` slip through as a false ACCEPT). Every other test in this
  // file only ever invalidates the widgetOrigin side, leaving that guard untested.
  assert.equal(isSameOrigin('', ''), false);
  assert.equal(isSameOrigin('not-a-url', 'also-not-a-url'), false);
  assert.equal(isSameOrigin('', 'not-a-url'), false);
  assert.equal(isSameOrigin('https://', 'https://'), false);
});

test('originOf itself rejects a userinfo or backslash authority, not only through isSameOrigin', () => {
  // isSameOrigin passing on these strings could equally mean "both sides parsed
  // differently" as "originOf refused to parse the malformed side at all" -- since
  // originOf is an exported, independently-relied-on contract, assert its null
  // return directly rather than only through the two-sided comparison.
  assert.equal(originOf('https://widget.acme.mentiora.ai@evil.com/x'), null);
  assert.equal(originOf('https://widget.acme.mentiora.ai\\.evil.com/'), null);
});

test('a trailing dot on the host is a different origin (denied, not matched)', () => {
  assert.equal(
    isSameOrigin('https://widget.acme.mentiora.ai./x', 'https://widget.acme.mentiora.ai'),
    false,
  );
});

test('a URL-encoded @ or backslash does not decode into the raw separator', () => {
  // %40 / %5C are NOT decoded before matching, so the whole encoded string is host —
  // still a different origin than the bare widget host, so still denied. The point of
  // the test is that this must not become a false ACCEPT via decode-then-compare.
  assert.equal(
    isSameOrigin('https://widget.acme.mentiora.ai%40evil.com/x', 'https://widget.acme.mentiora.ai'),
    false,
  );
  assert.equal(
    isSameOrigin(
      'https://widget.acme.mentiora.ai%5C.evil.com/x',
      'https://widget.acme.mentiora.ai',
    ),
    false,
  );
});

test('a null byte inside "javascript:" recombines under clean(), denied by the allow-list', () => {
  // clean() is a global replace, not a trim, so the embedded NUL disappears and
  // 'java' + 'script:' fuse back into 'javascript:'. What denies it is the
  // allow-list, not the NUL surviving to break the scheme match.
  assert.equal(schemeOf('java\u0000script:alert(1)'), 'javascript:');
  assert.equal(isAllowedExternal('java\u0000script:alert(1)'), false);
});

test('a tab inside "https:" is stripped by clean() and recombines to a valid scheme', () => {
  // Same recombination as above, but landing on an ALLOWED scheme: clean() strips the
  // tab (C0), so 'ht\ttps:' becomes 'https:' and the url is correctly allowed.
  assert.equal(schemeOf('ht\ttps://example.com'), 'https:');
  assert.equal(isAllowedExternal('ht\ttps://example.com'), true);
});

test('mixed case in the scheme only is still recognised', () => {
  assert.equal(schemeOf('HtTpS://example.com'), 'https:');
  assert.equal(isAllowedExternal('HtTpS://example.com'), true);
});

test('an IPv6 host is a different literal string than the configured hostname', () => {
  assert.equal(isSameOrigin('https://[::1]/x', 'https://widget.acme.mentiora.ai'), false);
  // and IPv6-vs-IPv6 matches by exact string
  assert.equal(isSameOrigin('https://[::1]:8443/x', 'https://[::1]:8443'), true);
});

test('a trailing space on the host is stripped by clean(), changing what host is compared', () => {
  // clean() strips trailing whitespace (C0/space) from the whole string, so
  // 'https://widget.acme.mentiora.ai /x' becomes 'https://widget.acme.mentiora.ai/x'
  // -- i.e. it does NOT create a spurious host that reads as same-origin by accident.
  assert.equal(
    isSameOrigin('https://widget.acme.mentiora.ai /evil', 'https://widget.acme.mentiora.ai'),
    true,
  );
});

test('single-slash and triple-slash forms are not treated as authority-bearing', () => {
  // One slash: '://' is matched as a literal, so 'https:/host' never reaches the
  // authority capture at all.
  assert.equal(originOf('https:/widget.acme.mentiora.ai'), null);
  assert.equal(
    isSameOrigin('https:/widget.acme.mentiora.ai', 'https://widget.acme.mentiora.ai'),
    false,
  );
  // Three slashes: after the literal '//', the third '/' is itself excluded from the
  // host character class, so the host group has nothing to capture and the whole
  // match fails -- it must NOT fall through to an empty/host-less same-origin match.
  assert.equal(originOf('https:///widget.acme.mentiora.ai'), null);
  assert.equal(
    isSameOrigin('https:///widget.acme.mentiora.ai', 'https://widget.acme.mentiora.ai'),
    false,
  );
});

// A fragment jump is the same document. Treating it as a load boundary in
// MentioraWidget's `onShouldStartLoadWithRequest` drops a live session key.
test('isSameDocument ignores the fragment and nothing else', () => {
  const base = 'https://w.x.ai/h/rn/k';
  assert.equal(isSameDocument(base, `${base}#thread-2`), true);
  assert.equal(isSameDocument(`${base}#a`, `${base}#b`), true);
  assert.equal(isSameDocument(base, `${base}#`), true, 'an empty fragment is still non-null');
  assert.equal(isSameDocument(base, `${base}?thread=2`), false);
  assert.equal(isSameDocument(base, `${base}/other`), false);
  assert.equal(isSameDocument(base, 'https://w.x.ai/h/rn/other'), false);
});

// Per the HTML navigate algorithm a navigation is fragment-only when the TARGET
// carries a fragment. Reporting either of these as "same document" leaves a
// genuinely new document unable to initialize for 8s.
test('a same-URL reload and a fragment removal are both new documents', () => {
  const base = 'https://w.x.ai/h/rn/k';
  assert.equal(isSameDocument(base, base), false, 'location.reload() is a full navigation');
  assert.equal(isSameDocument(`${base}#a`, base), false, 'dropping the fragment reloads');
});
