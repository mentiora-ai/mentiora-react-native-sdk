// Bridge wiring. The composition root is the first place any of the modules below
// meets another, so these are integration tests: a real peer, a real random source,
// a real runtime, and the mock WebView as the only stand-in.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import {
  __lastWebView,
  __resetWebViews,
  __webViews,
  type MockWebViewRef,
} from '../../__mocks__/react-native-webview';
import { MentioraWidget } from '../MentioraWidget';
import { RANDOM_REPLY_TAG, toBase64Url } from '../random';
import { __resetRuntimes, getRuntime } from '../runtime';
import { SDK_NAME, SDK_VERSION } from '../version';

const ORIGIN = 'https://w.x.ai';
const KEY = 'pk_wgt_a';

const openURL = Linking.openURL as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  __resetRuntimes();
  __resetWebViews();
});

const scripts = (view: MockWebViewRef = __lastWebView()): string[] =>
  (view.injectJavaScript as jest.Mock).mock.calls.map(([script]: [string]) => script);

// Host-to-page messages only. The random-bytes request goes out through the same
// channel and is not a bridge message, so it is filtered rather than parsed.
const BRIDGE_INJECTION = /^window\.mentioraHost\.receive\((.*)\);true;$/s;

const sentFrom = (view: MockWebViewRef): Record<string, unknown>[] =>
  scripts(view).flatMap((script) => {
    const m = BRIDGE_INJECTION.exec(script);
    return m ? [JSON.parse(JSON.parse(m[1] as string) as string) as Record<string, unknown>] : [];
  });

const sent = (): Record<string, unknown>[] => sentFrom(__lastWebView());

const waitForSent = (n: number): Promise<void> =>
  waitFor(() => {
    expect(sent().length).toBeGreaterThanOrEqual(n);
  });

// The scripts that are random-bytes REQUESTS, newest last.
const randomScripts = (): string[] => scripts().filter((s) => s.includes(RANDOM_REPLY_TAG));

// Each request carries its own nonce and only a reply echoing it counts: the tag
// alone is a module constant anything that can postMessage could spell.
const nonceOf = (script: string): string => {
  const m = /,k="([^"]+)"/.exec(script);
  if (!m) throw new Error('the injected random script carries no nonce');
  return m[1] as string;
};

const answerLastRandom = (el: ReturnType<typeof screen.getByTestId>, count = 16) =>
  fireEvent(el, 'message', {
    nativeEvent: {
      data: JSON.stringify({
        tag: RANDOM_REPLY_TAG,
        nonce: nonceOf(randomScripts().at(-1) as string),
        bytes: Array(count).fill(7),
      }),
    },
  });

const initialize = (el: ReturnType<typeof screen.getByTestId>, protocolVersion = 1) =>
  fireEvent(el, 'message', {
    nativeEvent: {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 'r1',
        method: 'mentiora/initialize',
        params: { protocolVersion },
      }),
    },
  });

const mount = async () => {
  await render(<MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} />);
  return screen.getByTestId('mentiora-webview');
};

test('loads the embed URL the contract specifies', async () => {
  const el = await mount();
  expect(el.props.source).toEqual({ uri: `${ORIGIN}/h/rn/${KEY}` });
});

test('onMessage always set, or react-native-webview never injects postMessage', async () => {
  const el = await mount();
  expect(typeof el.props.onMessage).toBe('function');
});

test('the library origin whitelist is opened so our matcher is the only gate', async () => {
  const el = await mount();
  // Left at its default (`http://*`, `https://*`), react-native-webview hands any
  // other scheme straight to Linking WITHOUT calling onShouldStartLoadWithRequest
  // (WebViewShared.tsx, createOnShouldStartLoadWithRequest) — `intent:` and `file:`
  // would bypass isAllowedExternal entirely.
  expect(el.props.originWhitelist).toEqual(['*']);
  expect(el.props.setSupportMultipleWindows).toBe(true);
});

test('answers initialize with OUR protocol version and a session key', async () => {
  const el = await mount();
  await initialize(el);
  await waitForSent(1);
  const reply = sent().at(-1) as { result?: Record<string, unknown> };
  expect(reply.result?.protocolVersion).toBe(1);
  expect(typeof reply.result?.sessionKey).toBe('string');
  expect((reply.result?.sessionKey as string | undefined)?.length ?? 0).toBeGreaterThan(0);
  expect(typeof reply.result?.installId).toBe('string');
  // The generated constants, not a literal that breaks on every version bump. What
  // this pins is that the handler reports our descriptor at all; a stale version.ts
  // is caught by the release guard.
  expect(reply.result?.sdk).toEqual({ name: SDK_NAME, version: SDK_VERSION });
});

test('an unsupported protocolVersion still gets a result, never -32005', async () => {
  const el = await mount();
  await initialize(el, 99);
  await waitForSent(1);
  const reply = sent().at(-1) as { result?: Record<string, unknown>; error?: unknown };
  expect(reply.error).toBeUndefined();
  expect(reply.result?.protocolVersion).toBe(1);
});

test('every injected script ends in true; or injectJavaScript fails silently', async () => {
  const el = await mount();
  await initialize(el);
  await waitForSent(1);
  expect(scripts().length).toBeGreaterThan(0);
  for (const script of scripts()) expect(script.endsWith('true;')).toBe(true);
});

test('the random reply is taken by the router and never reaches the peer', async () => {
  // Zero injections proves nothing on its own: a `{tag, bytes}` payload reaching
  // `peer.receive` ALSO sends nothing — `parseInbound` returns null, there is no
  // string `id` to answer into, and `respondOrDrop` warns and drops. The peer's
  // `warn` is the only positive evidence of whether it saw the message at all,
  // and this component routes it to `console.warn` under __DEV__.
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const el = await mount();
    await initialize(el);
    await waitFor(() => {
      expect(randomScripts()).toHaveLength(1);
    });
    await answerLastRandom(el);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
  }
});

// The nonce lives in the injected script, which runs in the main frame only.
// Authenticating the reply on `obj.tag` alone — a module constant — lets the page's
// sandboxed custom-block iframe answer the host's pending request with 16 bytes of
// its own choosing and pick both the session key and the install id.
test('a tagged reply with the wrong nonce cannot choose the session key', async () => {
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const el = await mount();
    await initialize(el);
    await waitFor(() => {
      expect(randomScripts()).toHaveLength(1);
    });

    // The attacker's 16 zero bytes, with the tag it can read off any bundle.
    await fireEvent(el, 'message', {
      nativeEvent: {
        data: JSON.stringify({ tag: RANDOM_REPLY_TAG, nonce: 'guessed', bytes: Array(16).fill(0) }),
      },
    });
    expect(sent()).toHaveLength(0);
    // Declined by the router, so it fell through to the peer, which dropped it
    // id-less — positive evidence that it was NOT treated as our reply.
    expect(warn).toHaveBeenCalled();

    // The real page still completes the handshake, and the key is not the
    // attacker's all-zero one.
    await answerLastRandom(el);
    await waitFor(() => {
      expect(randomScripts().length).toBeGreaterThanOrEqual(2);
    });
    await answerLastRandom(el);
    await waitForSent(1);
    const reply = sent().at(-1) as { result?: Record<string, unknown> };
    expect(reply.result?.sessionKey).toEqual(expect.any(String));
    expect(reply.result?.sessionKey).not.toBe(toBase64Url(new Uint8Array(16)));
  } finally {
    warn.mockRestore();
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
  }
});

test('without host WebCrypto the session key comes from the page, over two round trips', async () => {
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    const el = await mount();
    await initialize(el);
    // One request for the session key, one for the install id this launch mints.
    await waitFor(() => {
      expect(scripts().length).toBeGreaterThanOrEqual(1);
    });
    await answerLastRandom(el);
    await waitFor(() => {
      expect(scripts().length).toBeGreaterThanOrEqual(2);
    });
    await answerLastRandom(el);
    await waitForSent(1);
    const reply = sent().at(-1) as { result?: Record<string, unknown> };
    expect(typeof reply.result?.sessionKey).toBe('string');
    expect(typeof reply.result?.installId).toBe('string');
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
  }
});

test("same-origin navigation is allowed so the page's own sandbox iframe still loads", async () => {
  const el = await mount();
  const allowed = await fireEvent(el, 'shouldStartLoadWithRequest', {
    url: `${ORIGIN}/h/rn/${KEY}/inner`,
    isTopFrame: false,
  });
  expect(allowed).toBe(true);
});

test('a same-origin sub-frame navigation does NOT clear the session key', async () => {
  const el = await mount();
  await initialize(el);
  await waitForSent(1);
  const key = (sent().at(-1) as { result: { sessionKey: string } }).result.sessionKey;
  await fireEvent(el, 'shouldStartLoadWithRequest', {
    url: `${ORIGIN}/h/rn/${KEY}/inner`,
    isTopFrame: false,
  });
  await fireEvent(el, 'message', {
    nativeEvent: {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 'u1',
        method: 'mentiora/openUrl',
        params: { sessionKey: key, url: 'https://ok.example/x' },
      }),
    },
  });
  await waitForSent(2);
  // The positive result, not `not.toMatchObject({error:{code:-32001}})`, which
  // would also pass on -32602 or -32603 — i.e. on the session key surviving but
  // everything else being broken.
  expect(sent().at(-1)).toMatchObject({ id: 'u1', result: null });
});

test('an allowed top-frame navigation is a load boundary and resets the session', async () => {
  const el = await mount();
  // The document itself commits first, so the navigation below proves that a
  // different document resets, not merely that the first top-frame request does.
  await fireEvent(el, 'shouldStartLoadWithRequest', {
    url: `${ORIGIN}/h/rn/${KEY}`,
    isTopFrame: true,
  });
  await initialize(el);
  await waitForSent(1);
  const key = (sent().at(-1) as { result: { sessionKey: string } }).result.sessionKey;
  await fireEvent(el, 'shouldStartLoadWithRequest', {
    url: `${ORIGIN}/h/rn/${KEY}?thread=2`,
    isTopFrame: true,
  });
  await fireEvent(el, 'message', {
    nativeEvent: {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 'u1',
        method: 'mentiora/openUrl',
        params: { sessionKey: key, url: 'https://ok.example/x' },
      }),
    },
  });
  await waitForSent(2);
  expect(sent().at(-1)).toMatchObject({ error: { code: -32001 } });
});

// `beginFreshLoad` runs only when the document actually changed. Calling it on
// every same-origin top-frame request makes a `/chat` -> `/chat#thread` jump drop a
// live session key and reopen the keyless `initialize` latch while the page and its
// sandbox iframe are still running: every later page call takes -32001 and the
// watchdog reloads a healthy page.
test('a fragment-only navigation is not a load boundary', async () => {
  const el = await mount();
  await fireEvent(el, 'shouldStartLoadWithRequest', {
    url: `${ORIGIN}/h/rn/${KEY}`,
    isTopFrame: true,
  });
  await initialize(el);
  await waitForSent(1);
  const key = (sent().at(-1) as { result: { sessionKey: string } }).result.sessionKey;

  const allowed = await fireEvent(el, 'shouldStartLoadWithRequest', {
    url: `${ORIGIN}/h/rn/${KEY}#thread-2`,
    isTopFrame: true,
  });
  expect(allowed).toBe(true);

  await fireEvent(el, 'message', {
    nativeEvent: {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 'u1',
        method: 'mentiora/openUrl',
        params: { sessionKey: key, url: 'https://ok.example/x' },
      }),
    },
  });
  await waitForSent(2);
  // The positive result, not `not.toMatchObject({error:{code:-32001}})`, which
  // would also pass on -32602 or -32603.
  expect(sent().at(-1)).toMatchObject({ id: 'u1', result: null });
});

test('a fragment jump does NOT reopen the keyless initialize latch', async () => {
  const el = await mount();
  await fireEvent(el, 'shouldStartLoadWithRequest', {
    url: `${ORIGIN}/h/rn/${KEY}`,
    isTopFrame: true,
  });
  await initialize(el);
  await waitForSent(1);
  await fireEvent(el, 'shouldStartLoadWithRequest', {
    url: `${ORIGIN}/h/rn/${KEY}#thread-2`,
    isTopFrame: true,
  });
  await initialize(el); // the same document asking twice
  await waitForSent(2);
  expect(sent().at(-1)).toMatchObject({ error: { code: -32600 } });
});

// A same-URL navigation and a fragment removal are both full document navigations
// per the HTML navigate algorithm. Reading either as a fragment jump — which
// splitting on '#' and comparing does — leaves the new document's `initialize`
// answered -32600: a blank widget until the 8s watchdog reloads it, with the
// one-reload budget spent. The third row isolates the `navigationType` check, since
// its two URLs are fragment-identical and no URL comparison can catch it.
test.each([
  ['a same-URL navigation (location.reload / a link to the current path)', '', '', undefined],
  ['a fragment removal (#t -> the bare path)', '#t', '', undefined],
  ["iOS's reload navigationType over an unchanged fragment URL", '#t', '#t', 'reload'],
] as const)('%s is a load boundary', async (_label, firstSuffix, secondSuffix, navigationType) => {
  const el = await mount();
  await fireEvent(el, 'shouldStartLoadWithRequest', {
    url: `${ORIGIN}/h/rn/${KEY}${firstSuffix}`,
    isTopFrame: true,
  });
  await initialize(el);
  await waitForSent(1);
  const key = (sent().at(-1) as { result: { sessionKey: string } }).result.sessionKey;

  await fireEvent(el, 'shouldStartLoadWithRequest', {
    url: `${ORIGIN}/h/rn/${KEY}${secondSuffix}`,
    isTopFrame: true,
    ...(navigationType ? { navigationType } : {}),
  });
  await fireEvent(el, 'message', {
    nativeEvent: {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 'u1',
        method: 'mentiora/openUrl',
        params: { sessionKey: key, url: 'https://ok.example/x' },
      }),
    },
  });
  await waitForSent(2);
  expect(sent().at(-1)).toMatchObject({ error: { code: -32001 } });
});

test('a bare onLoadStart is NOT wired — Android fires it on in-page history changes', async () => {
  const el = await mount();
  expect(el.props.onLoadStart).toBeUndefined();
});

test('a cross-origin navigation is denied in the WebView and handed to the OS', async () => {
  const el = await mount();
  const allowed = await fireEvent(el, 'shouldStartLoadWithRequest', {
    url: 'https://evil.com/x',
    isTopFrame: true,
  });
  expect(allowed).toBe(false);
  await waitFor(() => {
    expect(openURL).toHaveBeenCalledWith('https://evil.com/x');
  });
});

test('a userinfo URL that looks same-origin is denied — it is not our origin', async () => {
  const el = await mount();
  const allowed = await fireEvent(el, 'shouldStartLoadWithRequest', {
    url: `${ORIGIN}@evil.com/x`,
    isTopFrame: true,
  });
  expect(allowed).toBe(false);
});

test('a denied non-https navigation is never handed to the OS either', async () => {
  const el = await mount();
  const allowed = await fireEvent(el, 'shouldStartLoadWithRequest', {
    url: 'intent://evil/#Intent;scheme=https;end',
    isTopFrame: true,
  });
  expect(allowed).toBe(false);
  // NOT `waitFor(() => expect(…).not.toHaveBeenCalled())`: a negative passes on
  // waitFor's first synchronous evaluation and returns immediately, so it never
  // waits and an implementation calling Linking one microtask later slips
  // through. `openExternal` is async; flush it, then assert.
  await act(async () => {});
  expect(openURL).not.toHaveBeenCalled();
});

test('onOpenWindow routes through the same external gate', async () => {
  const el = await mount();
  await fireEvent(el, 'openWindow', { nativeEvent: { targetUrl: 'https://docs.example/a' } });
  await waitFor(() => {
    expect(openURL).toHaveBeenCalledWith('https://docs.example/a');
  });
});

test('a mailto link opens via Linking; a javascript: link is refused with -32003', async () => {
  const el = await mount();
  await initialize(el);
  await waitForSent(1);
  const key = (sent().at(-1) as { result: { sessionKey: string } }).result.sessionKey;
  const call = (id: string, url: string) =>
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'mentiora/openUrl',
      params: { sessionKey: key, url },
    });
  await fireEvent(el, 'message', { nativeEvent: { data: call('u1', 'mailto:a@b.com') } });
  await waitFor(() => {
    expect(openURL).toHaveBeenCalledWith('mailto:a@b.com');
  });
  await fireEvent(el, 'message', { nativeEvent: { data: call('u2', 'javascript:alert(1)') } });
  await waitForSent(3);
  const refusal = sent().at(-1) as { error?: { code: number } };
  expect(refusal.error?.code).toBe(-32003);
});

test('onOpenUrl returning true takes over and the page is answered success', async () => {
  const onOpenUrl = jest.fn(() => true);
  await render(<MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} onOpenUrl={onOpenUrl} />);
  const el = screen.getByTestId('mentiora-webview');
  await initialize(el);
  await waitForSent(1);
  const key = (sent().at(-1) as { result: { sessionKey: string } }).result.sessionKey;
  await fireEvent(el, 'message', {
    nativeEvent: {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 'u1',
        method: 'mentiora/openUrl',
        params: { sessionKey: key, url: 'https://docs.example/a' },
      }),
    },
  });
  await waitForSent(2);
  expect(onOpenUrl).toHaveBeenCalledWith('https://docs.example/a');
  expect(openURL).not.toHaveBeenCalled();
  expect(sent().at(-1)).toMatchObject({ id: 'u1', result: null });
});

test('page notifications surface through onEvent', async () => {
  const onEvent = jest.fn();
  await render(<MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} onEvent={onEvent} />);
  const el = screen.getByTestId('mentiora-webview');
  await initialize(el);
  await waitForSent(1);
  const key = (sent().at(-1) as { result: { sessionKey: string } }).result.sessionKey;
  await fireEvent(el, 'message', {
    nativeEvent: {
      data: JSON.stringify({
        jsonrpc: '2.0',
        method: 'mentiora/ready',
        params: { sessionKey: key },
      }),
    },
  });
  await waitFor(() => {
    expect(onEvent).toHaveBeenCalledWith({ type: 'ready' });
  });
});

test('refreshIdentity with no identity configured answers -32002, not -32603', async () => {
  const el = await mount();
  await initialize(el);
  await waitForSent(1);
  const key = (sent().at(-1) as { result: { sessionKey: string } }).result.sessionKey;
  await fireEvent(el, 'message', {
    nativeEvent: {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 'r2',
        method: 'mentiora/refreshIdentity',
        params: { sessionKey: key },
      }),
    },
  });
  await waitForSent(2);
  expect(sent().at(-1)).toMatchObject({ id: 'r2', error: { code: -32002 } });
});

test('the identity provider is read live, so a reconfigure is not ignored', async () => {
  const first = { getToken: () => 'token-one' };
  const view = await render(
    <MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} identity={first} />,
  );
  // Same embedKey, a different `identity` reference: getRuntime swaps the provider
  // on the existing runtime in place. A widget holding a local copy keeps the old one.
  const second = { getToken: () => 'token-two' };
  await view.rerender(<MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} identity={second} />);
  const el = screen.getByTestId('mentiora-webview');
  await initialize(el);
  await waitForSent(1);
  expect(sent().at(-1)).toMatchObject({ result: { identityToken: 'token-two' } });
});

test('two widgets on one embed key share a runtime and mint ONE install id', async () => {
  await render(
    <>
      <MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} />
      <MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} />
    </>,
  );
  const els = screen.getAllByTestId('mentiora-webview');
  expect(els).toHaveLength(2);
  for (const el of els) {
    await initialize(el);
  }
  // Read BOTH WebViews: `sent()` alone sees only the last one, and one result can
  // never disagree with itself.
  await waitFor(() => {
    for (const view of __webViews()) expect(sentFrom(view).length).toBeGreaterThanOrEqual(1);
  });
  const ids = __webViews()
    .flatMap((view) => sentFrom(view))
    .filter((m) => 'result' in m)
    .map((m) => (m as { result: { installId: string } }).result.installId);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(1);
});

// Degraded storage owes the caller both halves: a `__DEV__` warning that every
// launch creates a new anonymous user, and an `onEvent` so the state is visible in a
// release build. `resolveStorage` computes the flag; the composition root is the
// only place that reads it, so the wiring can only be asserted here.
//
// The degraded runtime is built by hand rather than by unmocking the AsyncStorage
// peer, which `jest.setup.ts` mocks for the whole suite. Mutating the memoised
// runtime is what exercises the read. Returns the `console.warn` spy too, which also
// keeps the real warning off every one of these tests.
const degradeStorage = (reason: 'peer-absent' | 'no-require' = 'peer-absent') => {
  const rt = getRuntime({ widgetOrigin: ORIGIN, embedKey: KEY });
  rt.storage = { ephemeral: true, reason, detail: 'no peer here' };
  return jest.spyOn(console, 'warn').mockImplementation(() => {});
};

test('degraded storage is reported through onEvent, not only to a stripped __DEV__ warning', async () => {
  const warn = degradeStorage();
  const onEvent = jest.fn();
  try {
    await render(<MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} onEvent={onEvent} />);
    expect(onEvent).toHaveBeenCalledWith({ type: 'storageUnavailable', reason: 'peer-absent' });
    // The warning too: the event alone leaves a dev with no console trace of why
    // their threads keep vanishing.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('peer-absent'));
  } finally {
    warn.mockRestore();
  }
});

test('the reason travels with the event — the three fallbacks need different fixes', async () => {
  // 'peer-absent' says "install the peer"; 'no-require' says "this build cannot
  // auto-resolve one at all, pass `storage`". A hard-coded reason passes the test
  // above and sends every customer down the wrong road.
  const warn = degradeStorage('no-require');
  const onEvent = jest.fn();
  try {
    await render(<MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} onEvent={onEvent} />);
    expect(onEvent).toHaveBeenCalledWith({ type: 'storageUnavailable', reason: 'no-require' });
  } finally {
    warn.mockRestore();
  }
});

test('working storage says nothing at all', async () => {
  const onEvent = jest.fn();
  await render(<MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} onEvent={onEvent} />);
  expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'storageUnavailable' }));
});

test('one degraded store is reported once per embed key, not once per presentation', async () => {
  // The Modal mounts a fresh `<MentioraWidget />` on every `Mentiora.open()`, so an
  // emit tied to mount fires on every open for a fact that has not changed.
  const warn = degradeStorage();
  const onEvent = jest.fn();
  try {
    const first = await render(
      <MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} onEvent={onEvent} />,
    );
    await first.unmount();
    await render(<MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} onEvent={onEvent} />);
    expect(
      onEvent.mock.calls.filter(([e]) => (e as { type: string }).type === 'storageUnavailable'),
    ).toHaveLength(1);
  } finally {
    warn.mockRestore();
  }
});

// `embedKey` is customer input dropped into a URL path segment. Without
// `encodeURIComponent`, a key containing `/` or `?` silently loads a different path,
// or another origin's query, instead of the widget.
test('embedKey is percent-encoded into its one path segment', async () => {
  await render(<MentioraWidget widgetOrigin={ORIGIN} embedKey="pk wgt/../x?y#z" />);
  expect(screen.getByTestId('mentiora-webview').props.source).toEqual({
    uri: `${ORIGIN}/h/rn/pk%20wgt%2F..%2Fx%3Fy%23z`,
  });
});
