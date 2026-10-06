import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { __lastWebView, __resetWebViews, __webViews } from '../../__mocks__/react-native-webview';
import { toBase64Url } from '../base64url';
import { MentioraWidget } from '../MentioraWidget';
import { RANDOM_REPLY_TAG } from '../random';
import { __resetRuntimes, getRuntime } from '../runtime';
import { SDK_NAME, SDK_VERSION } from '../version';
import {
  answerLastRandom,
  initialize,
  KEY,
  ORIGIN,
  randomScripts,
  scripts,
  sent,
  sentFrom,
  WIDGET_URL,
} from './helpers';

const openURL = Linking.openURL as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  __resetRuntimes();
  __resetWebViews();
});

const waitForSent = (n: number): Promise<void> =>
  waitFor(() => {
    expect(sent().length).toBeGreaterThanOrEqual(n);
  });

const mount = async () => {
  await render(<MentioraWidget widgetUrl={WIDGET_URL} />);
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
  // At its default (`http://*`, `https://*`) react-native-webview hands any other scheme
  // to Linking without calling onShouldStartLoadWithRequest, bypassing isAllowedExternal.
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
  expect(reply.result?.sdk).toEqual({ name: SDK_NAME, version: SDK_VERSION });
});

const initializeResult = async (props: { brand?: string } = {}) => {
  await render(<MentioraWidget widgetUrl={WIDGET_URL} {...props} />);
  await initialize(screen.getByTestId('mentiora-webview'));
  await waitForSent(1);
  return (sent().at(-1) as { result: Record<string, unknown> }).result;
};

test('brand rides along trimmed; unset or blank leaves the key out', async () => {
  expect((await initializeResult({ brand: ' be ' })).brand).toBe('be');
  __resetRuntimes();
  __resetWebViews();
  expect(await initializeResult()).not.toHaveProperty('brand');
  __resetRuntimes();
  __resetWebViews();
  expect(await initializeResult({ brand: ' ' })).not.toHaveProperty('brand');
});

test('an over-long brand throws at mount', async () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(
      render(<MentioraWidget widgetUrl={WIDGET_URL} brand={'b'.repeat(65)} />),
    ).rejects.toThrow(/brand/);
  } finally {
    error.mockRestore();
  }
});

test('appId is left out when neither Expo module is installed', async () => {
  expect(await initializeResult()).not.toHaveProperty('appId');
});

test('appId is the host app id that expo-application reads', async () => {
  jest.doMock('expo-application', () => ({ applicationId: 'com.acme.nl' }), { virtual: true });
  try {
    expect((await initializeResult()).appId).toBe('com.acme.nl');
  } finally {
    jest.dontMock('expo-application');
  }
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
  // Zero injections proves nothing; the peer's `warn` is the only positive evidence.
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

    await fireEvent(el, 'message', {
      nativeEvent: {
        data: JSON.stringify({ tag: RANDOM_REPLY_TAG, nonce: 'guessed', bytes: Array(16).fill(0) }),
      },
    });
    expect(sent()).toHaveLength(0);
    expect(warn).toHaveBeenCalled();

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
  // The positive result: a negated -32001 check would also pass on -32602 or -32603.
  expect(sent().at(-1)).toMatchObject({ id: 'u1', result: null });
});

test('an allowed top-frame navigation is a load boundary and resets the session', async () => {
  const el = await mount();
  // The document commits first, so the navigation below proves a DIFFERENT document resets.
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
  await initialize(el);
  await waitForSent(2);
  expect(sent().at(-1)).toMatchObject({ error: { code: -32600 } });
});

// Same-URL and fragment-removal navigations are full document loads. The third row's
// URLs are fragment-identical, isolating `navigationType`.
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
  // A negative inside `waitFor` passes on its first synchronous check, so flush, then assert.
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
  await render(<MentioraWidget widgetUrl={WIDGET_URL} onOpenUrl={onOpenUrl} />);
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
  await render(<MentioraWidget widgetUrl={WIDGET_URL} onEvent={onEvent} />);
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
  const view = await render(<MentioraWidget widgetUrl={WIDGET_URL} identity={first} />);
  const second = { getToken: () => 'token-two' };
  await view.rerender(<MentioraWidget widgetUrl={WIDGET_URL} identity={second} />);
  const el = screen.getByTestId('mentiora-webview');
  await initialize(el);
  await waitForSent(1);
  expect(sent().at(-1)).toMatchObject({ result: { identityToken: 'token-two' } });
});

test('a new identity reloads a booted page, which keeps the credential it booted with', async () => {
  const first = { getToken: () => 'token-one' };
  const view = await render(<MentioraWidget widgetUrl={WIDGET_URL} identity={first} />);
  await initialize(screen.getByTestId('mentiora-webview'));
  await waitForSent(1);
  const booted = __lastWebView();
  await view.rerender(<MentioraWidget widgetUrl={WIDGET_URL} identity={first} />);
  expect(__lastWebView()).toBe(booted);

  await view.rerender(
    <MentioraWidget widgetUrl={WIDGET_URL} identity={{ getToken: () => 'token-two' }} />,
  );
  expect(__lastWebView()).not.toBe(booted);
  await initialize(screen.getByTestId('mentiora-webview'));
  await waitFor(() => {
    expect(sent().at(-1)).toMatchObject({ result: { identityToken: 'token-two' } });
  });
});

test('two widgets on one embed key share a runtime and mint ONE install id', async () => {
  await render(
    <>
      <MentioraWidget widgetUrl={WIDGET_URL} />
      <MentioraWidget widgetUrl={WIDGET_URL} />
    </>,
  );
  const els = screen.getAllByTestId('mentiora-webview');
  expect(els).toHaveLength(2);
  for (const el of els) {
    await initialize(el);
  }
  // Read BOTH WebViews: `sent()` alone sees only the last, which cannot disagree with itself.
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

// Built by hand because `jest.setup.ts` mocks the peer suite-wide.
const degradeStorage = (reason: 'peer-absent' | 'load-threw' = 'peer-absent') => {
  const rt = getRuntime({ widgetUrl: WIDGET_URL });
  rt.storage = { ephemeral: true, reason, detail: 'no peer here' };
  return jest.spyOn(console, 'warn').mockImplementation(() => {});
};

test('degraded storage is reported through onEvent, not only to a stripped __DEV__ warning', async () => {
  const warn = degradeStorage();
  const onEvent = jest.fn();
  try {
    await render(<MentioraWidget widgetUrl={WIDGET_URL} onEvent={onEvent} />);
    expect(onEvent).toHaveBeenCalledWith({ type: 'storageUnavailable', reason: 'peer-absent' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('peer-absent'));
  } finally {
    warn.mockRestore();
  }
});

test('the reason travels with the event — the two fallbacks need different fixes', async () => {
  const warn = degradeStorage('load-threw');
  const onEvent = jest.fn();
  try {
    await render(<MentioraWidget widgetUrl={WIDGET_URL} onEvent={onEvent} />);
    expect(onEvent).toHaveBeenCalledWith({ type: 'storageUnavailable', reason: 'load-threw' });
  } finally {
    warn.mockRestore();
  }
});

test('working storage says nothing at all', async () => {
  const onEvent = jest.fn();
  await render(<MentioraWidget widgetUrl={WIDGET_URL} onEvent={onEvent} />);
  expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'storageUnavailable' }));
});

test('one degraded store is reported once per embed key, not once per presentation', async () => {
  // A fresh `<MentioraWidget />` mounts per `Mentiora.open()`, so a mount-tied emit repeats.
  const warn = degradeStorage();
  const onEvent = jest.fn();
  try {
    const first = await render(<MentioraWidget widgetUrl={WIDGET_URL} onEvent={onEvent} />);
    await first.unmount();
    await render(<MentioraWidget widgetUrl={WIDGET_URL} onEvent={onEvent} />);
    expect(
      onEvent.mock.calls.filter(([e]) => (e as { type: string }).type === 'storageUnavailable'),
    ).toHaveLength(1);
  } finally {
    warn.mockRestore();
  }
});

test('an encoded key stays percent-encoded in its one path segment', async () => {
  await render(<MentioraWidget widgetUrl={`${ORIGIN}/h/rn/pk%20wgt%2F..%2Fx%3Fy%23z`} />);
  expect(screen.getByTestId('mentiora-webview').props.source).toEqual({
    uri: `${ORIGIN}/h/rn/pk%20wgt%2F..%2Fx%3Fy%23z`,
  });
});
