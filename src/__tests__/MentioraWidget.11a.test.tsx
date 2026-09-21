// src/__tests__/MentioraWidget.11a.test.tsx
//
// Task 11a: bridge wiring. The composition root is the first place any of the
// modules below meets another, so these tests are integration tests by nature —
// a real peer, a real random source, a real runtime, and the mock WebView as the
// only stand-in.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import {
  __lastWebView,
  __resetWebViews,
  __webViews,
  type MockWebViewRef,
} from '../../__mocks__/react-native-webview';
import { MentioraWidget } from '../MentioraWidget';
import { RANDOM_REPLY_TAG } from '../random';
import { __resetRuntimes } from '../runtime';

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

// Host → page messages only. Task 5's random-bytes request goes out through the
// same channel and is not a bridge message, so it is filtered rather than parsed.
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

// The page's side of Task 5's random handshake. Only reached when the host has no
// WebCrypto of its own; under Jest `globalThis.crypto` exists, so the composition
// root passes it as `globalCrypto` and this is a stray message the router swallows.
const answerRandom = (el: ReturnType<typeof screen.getByTestId>, count = 16) =>
  fireEvent(el, 'message', {
    nativeEvent: { data: JSON.stringify({ tag: RANDOM_REPLY_TAG, bytes: Array(count).fill(7) }) },
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
  await answerRandom(el);
  await waitForSent(1);
  const reply = sent().at(-1) as { result?: Record<string, unknown> };
  expect(reply.result?.protocolVersion).toBe(1);
  expect(typeof reply.result?.sessionKey).toBe('string');
  expect((reply.result?.sessionKey as string | undefined)?.length ?? 0).toBeGreaterThan(0);
  expect(typeof reply.result?.installId).toBe('string');
  expect(reply.result?.sdk).toEqual({ name: '@mentiora/react-native-sdk', version: '0.0.1' });
});

test('an unsupported protocolVersion still gets a result, never -32005', async () => {
  const el = await mount();
  await initialize(el, 99);
  await answerRandom(el);
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
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const el = await mount();
    await answerRandom(el);
    expect(warn).not.toHaveBeenCalled();
    expect(sent()).toHaveLength(0);
    expect(scripts()).toHaveLength(0);
  } finally {
    warn.mockRestore();
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
    await answerRandom(el);
    await waitFor(() => {
      expect(scripts().length).toBeGreaterThanOrEqual(2);
    });
    await answerRandom(el);
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
  await answerRandom(el);
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
    await answerRandom(el);
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
