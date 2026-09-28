// `advanceTimersByTimeAsync` only: the sync form fires a timer's callback without
// draining the microtasks its awaits sit on.
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type React from 'react';
import { StrictMode, Suspense } from 'react';
import { Text } from 'react-native';
import { __lastWebView, __resetWebViews, __webViews } from '../../__mocks__/react-native-webview';
import { MentioraWidget } from '../MentioraWidget';
import { __resetRuntimes } from '../runtime';
import { DEFAULT_STRINGS } from '../ui/strings';
import { answerLastRandom, initialize, KEY, randomScripts, sent, WIDGET_URL } from './helpers';

beforeEach(() => {
  jest.useFakeTimers();
  __resetRuntimes();
  __resetWebViews();
});

afterEach(() => {
  jest.useRealTimers();
});

// A bare timer advance is outside `act()`, and the crash path calls `setState` inside one.
const advance = (ms: number) => act(async () => jest.advanceTimersByTimeAsync(ms));

const mount = async (onEvent?: jest.Mock) => {
  await render(<MentioraWidget widgetUrl={WIDGET_URL} onEvent={onEvent} />);
  return screen.getByTestId('mentiora-webview');
};

test('after 3 failed loads the error surface appears with retry and dismiss', async () => {
  const onEvent = jest.fn();
  const el = await mount(onEvent);
  for (let i = 0; i < 3; i++) {
    await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
    await advance(9000);
  }
  expect(screen.getByRole('button', { name: DEFAULT_STRINGS.retry })).toBeTruthy();
  expect(screen.getByRole('button', { name: DEFAULT_STRINGS.dismiss })).toBeTruthy();
  expect(onEvent).toHaveBeenCalledWith({ type: 'error', code: 'load_failed' });
});

test('no initialize within 8s reloads ONCE, then shows the error surface', async () => {
  const onEvent = jest.fn();
  await mount(onEvent);
  await advance(8000);
  expect(__lastWebView().reload).toHaveBeenCalledTimes(1);
  await advance(8000);
  expect(__lastWebView().reload).toHaveBeenCalledTimes(1);
  expect(onEvent).toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
});

test('a handshake timeout never spends the network retry ladder', async () => {
  const onEvent = jest.fn();
  await mount(onEvent);
  await advance(20000);
  const codes = onEvent.mock.calls.map(([e]) => (e as { code?: string }).code);
  // The negative alone also passes an implementation that emits nothing at all.
  expect(codes).toContain('handshake_timeout');
  expect(codes).not.toContain('load_failed');
});

test('a rejected handshake is reloaded by the RE-ARMED watchdog, not the mount-armed one', async () => {
  // Told apart by when they fire: mount-armed at 8s, re-armed at 2s + 8s.
  const realCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    const el = await mount();
    await initialize(el);
    await advance(9000);
    expect(__lastWebView().reload).not.toHaveBeenCalled();
    await advance(2000);
    expect(__lastWebView().reload).toHaveBeenCalledTimes(1);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true });
  }
});

// Fails unless `clearWatchdogTimer()` is the handler's first statement.
test('a handshake that succeeds at 7.9s is answered and NOT reloaded at 8s', async () => {
  const onEvent = jest.fn();
  const el = await mount(onEvent);
  await advance(7900); // the mount-armed watchdog has 100ms left
  await initialize(el);
  await advance(300);

  // The handshake really landed; without this a rejected `initialize` passes too.
  expect(sent().some((m) => 'result' in m)).toBe(true);
  expect(__lastWebView().reload).not.toHaveBeenCalled();
  expect(onEvent).not.toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
});

test('a handshake that lands BEFORE loadEnd is not reloaded a budget later', async () => {
  // `initialize` can land before native load-end (cached bundle). Arming on load-end then
  // started a watchdog nothing clears, reloading a working widget 8s later.
  const onEvent = jest.fn();
  const el = await mount(onEvent);
  await initialize(el);
  expect(sent().some((m) => 'result' in m)).toBe(true);

  await fireEvent(screen.getByTestId('mentiora-webview'), 'loadEnd', { nativeEvent: {} });
  await advance(9000);

  expect(__lastWebView().reload).not.toHaveBeenCalled();
  expect(onEvent).not.toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
});

test('a network-ladder reload that never re-initializes still gets caught by the watchdog', async () => {
  // Only `onLoadEnd` re-arms the watchdog; the ladder's own `reload()` is silent on Android.
  const onEvent = jest.fn();
  const el = await mount(onEvent);
  await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
  await advance(2000);
  expect(__lastWebView().reload).toHaveBeenCalledTimes(1);
  await fireEvent(screen.getByTestId('mentiora-webview'), 'loadEnd', { nativeEvent: {} });
  await advance(8000);
  expect(__lastWebView().reload).toHaveBeenCalledTimes(2);
  await advance(8000);
  expect(onEvent).toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
});

test('unmounting cancels the live watchdog — no reload, no error event, for a widget the host already closed', async () => {
  const onEvent = jest.fn();
  const view = await render(<MentioraWidget widgetUrl={WIDGET_URL} onEvent={onEvent} />);
  // Captured before unmount: `__lastWebView()` would throw afterwards, this ref will not.
  const { reload } = __lastWebView();
  await view.unmount();
  await advance(20000);
  expect(reload).not.toHaveBeenCalled();
  expect(onEvent).not.toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
});

test('Retry recovers a dead renderer — a remount, not a reload() on the corpse', async () => {
  const onEvent = jest.fn();
  await mount(onEvent);
  for (let i = 0; i < 4; i++) {
    await fireEvent(screen.getByTestId('mentiora-webview'), 'renderProcessGone', {
      nativeEvent: { didCrash: true },
    });
    await advance(9000);
  }
  expect(onEvent).toHaveBeenCalledWith({ type: 'error', code: 'renderer_crashed' });
  // Android requires a dead renderer's instance be destroyed, so the repair is a fresh one.
  const deadWebView = __lastWebView();
  await fireEvent.press(screen.getByRole('button', { name: DEFAULT_STRINGS.retry }));
  expect(__webViews()).toHaveLength(1);
  expect(__webViews()[0]).not.toBe(deadWebView);
  expect(deadWebView.reload).not.toHaveBeenCalled();
});

test('the error overlay is modal to a screen reader — both flags flip with errorCode', async () => {
  // No `getByProps` in this RNTL version, and neither flag has text, role or testID.
  const modalOverlays = () =>
    screen.container.queryAll((i) => i.props.accessibilityViewIsModal === true);

  const el = await mount();
  expect(el.props.importantForAccessibility).toBe('auto');
  expect(modalOverlays()).toHaveLength(0);
  for (let i = 0; i < 3; i++) {
    await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
    await advance(9000);
  }
  // RNTL's default queries exclude `importantForAccessibility="no-hide-descendants"`,
  // the prop under test, so read it off `el`.
  expect(el.props.importantForAccessibility).toBe('no-hide-descendants');
  expect(modalOverlays()).toHaveLength(1);
});

test('onRenderProcessGone remounts up to 3 times then gives up', async () => {
  const onEvent = jest.fn();
  await mount(onEvent);
  for (let i = 0; i < 4; i++) {
    await fireEvent(screen.getByTestId('mentiora-webview'), 'renderProcessGone', {
      nativeEvent: { didCrash: true },
    });
    await advance(9000);
  }
  expect(onEvent).toHaveBeenCalledWith({ type: 'error', code: 'renderer_crashed' });
});

test('onContentProcessDidTerminate shares the crash cap with onRenderProcessGone', async () => {
  const onEvent = jest.fn();
  await mount(onEvent);
  for (let i = 0; i < 4; i++) {
    await fireEvent(screen.getByTestId('mentiora-webview'), 'contentProcessDidTerminate', {
      nativeEvent: {},
    });
    await advance(9000);
  }
  expect(onEvent).toHaveBeenCalledWith({ type: 'error', code: 'renderer_crashed' });
});

test('ONE incident raising two callbacks advances ONE counter', async () => {
  const onEvent = jest.fn();
  await mount(onEvent);
  await fireEvent(screen.getByTestId('mentiora-webview'), 'error', {
    nativeEvent: { description: 'net' },
  });
  await fireEvent(screen.getByTestId('mentiora-webview'), 'renderProcessGone', {
    nativeEvent: { didCrash: true },
  });
  await advance(9000);
  // Only the first terminal callback per generation picks a path, so the counter still needs
  // its full cap of 4; without the `handled` gate these same 3 incidents reach it early.
  for (let i = 0; i < 3; i++) {
    await fireEvent(screen.getByTestId('mentiora-webview'), 'renderProcessGone', {
      nativeEvent: { didCrash: true },
    });
    await advance(9000);
  }
  expect(screen.queryByRole('button', { name: DEFAULT_STRINGS.retry })).toBeNull();
  expect(onEvent).not.toHaveBeenCalledWith({ type: 'error', code: 'renderer_crashed' });
});

test('Retry clears the surface and reloads; Dismiss emits close without reloading', async () => {
  const onEvent = jest.fn();
  const el = await mount(onEvent);
  for (let i = 0; i < 3; i++) {
    await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
    await advance(9000);
  }
  await fireEvent.press(screen.getByRole('button', { name: DEFAULT_STRINGS.retry }));
  expect(screen.queryByRole('button', { name: DEFAULT_STRINGS.retry })).toBeNull();
  expect(screen.getByTestId('mentiora-webview')).toBeTruthy();
});

test('Dismiss emits close and stops rendering the WebView, with nothing else configured', async () => {
  const onEvent = jest.fn();
  const el = await mount(onEvent);
  for (let i = 0; i < 3; i++) {
    await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
    await advance(9000);
  }
  await fireEvent.press(screen.getByRole('button', { name: DEFAULT_STRINGS.dismiss }));
  expect(onEvent).toHaveBeenCalledWith({ type: 'close' });
  // A WebView under the overlay is hidden, so RNTL's default `queryByTestId` reads `null`.
  expect(screen.queryByTestId('mentiora-webview', { includeHiddenElements: true })).toBeNull();
  expect(screen.queryByRole('button', { name: DEFAULT_STRINGS.retry })).toBeNull();
});

type ErrorRender = NonNullable<React.ComponentProps<typeof MentioraWidget>['renderError']>;

const hostErrorScreen = () => {
  const last: { props?: Parameters<ErrorRender>[0] } = {};
  const renderError: ErrorRender = (props) => {
    last.props = props;
    return <Text testID="host-error">{props.code}</Text>;
  };
  return { renderError, last };
};

const failThreeLoads = async (el: ReturnType<typeof screen.getByTestId>) => {
  for (let i = 0; i < 3; i++) {
    await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
    await advance(9000);
  }
};

test('renderError replaces the built-in surface and still reports the error', async () => {
  const onEvent = jest.fn();
  const { renderError } = hostErrorScreen();
  await render(
    <MentioraWidget widgetUrl={WIDGET_URL} onEvent={onEvent} renderError={renderError} />,
  );
  await failThreeLoads(screen.getByTestId('mentiora-webview'));
  expect(screen.getByTestId('host-error').props.children).toBe('load_failed');
  expect(screen.queryByRole('button', { name: DEFAULT_STRINGS.retry })).toBeNull();
  expect(onEvent).toHaveBeenCalledWith({ type: 'error', code: 'load_failed' });
});

test("renderError's retry reloads and its dismiss closes, like the built-in buttons", async () => {
  const onEvent = jest.fn();
  const { renderError, last } = hostErrorScreen();
  await render(
    <MentioraWidget widgetUrl={WIDGET_URL} onEvent={onEvent} renderError={renderError} />,
  );
  await failThreeLoads(screen.getByTestId('mentiora-webview'));
  await act(async () => last.props?.retry());
  expect(screen.queryByTestId('host-error')).toBeNull();

  await failThreeLoads(screen.getByTestId('mentiora-webview'));
  await act(async () => last.props?.dismiss());
  expect(onEvent).toHaveBeenCalledWith({ type: 'close' });
  expect(screen.queryByTestId('mentiora-webview', { includeHiddenElements: true })).toBeNull();
});

test('an initialize handler that rejects ends at the error surface, not a dead widget', async () => {
  const onEvent = jest.fn();
  const store = new Map<string, string>([[`mentiora.wasSignedIn.${KEY}`, '1']]);
  const storage = {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      store.delete(k);
    },
  };
  await render(
    <MentioraWidget
      widgetUrl={WIDGET_URL}
      onEvent={onEvent}
      storage={storage}
      identity={{ getToken: () => Promise.reject(new Error('token endpoint down')) }}
    />,
  );
  const el = screen.getByTestId('mentiora-webview');
  await initialize(el);
  // Past the boot ladder's sleeps, then both watchdog cycles: reload, then give up.
  await advance(20000);

  // -32002 shows the handler was reached and rejected for want of an identity.
  expect(sent().some((m) => (m.error as { code?: number } | undefined)?.code === -32002)).toBe(
    true,
  );
  expect(onEvent).toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
  expect(screen.getByRole('button', { name: DEFAULT_STRINGS.retry })).toBeTruthy();
  expect(screen.getByRole('button', { name: DEFAULT_STRINGS.dismiss })).toBeTruthy();
});

test('a reload while the random round trip is parked does not poison the next handshake', async () => {
  const realCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    const el = await mount();
    await initialize(el); // page A parks a bytes() request that can never be answered
    await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
    // Past the ladder's first delay, short of the 2s timeout: the slot is still held.
    await advance(1500);
    expect(__lastWebView().reload).toHaveBeenCalledTimes(1);

    // Page A's parked request is still in the call log, so count from page B's start.
    const beforeB = randomScripts().length;
    await fireEvent(el, 'message', {
      nativeEvent: {
        data: JSON.stringify({
          jsonrpc: '2.0',
          id: 'b1',
          method: 'mentiora/initialize',
          params: { protocolVersion: 1 },
        }),
      },
    });
    // Two round trips, each answered with its own request's nonce, so the second waits.
    for (let i = 0; i < 2; i++) {
      await act(async () => {});
      expect(randomScripts()).toHaveLength(beforeB + i + 1);
      await answerLastRandom(el, { fill: 4 });
    }

    const answer = sent().find((m) => m.id === 'b1');
    expect(answer).toBeDefined();
    expect(answer?.error).toBeUndefined();
    expect((answer?.result as { sessionKey?: string } | undefined)?.sessionKey).toEqual(
      expect.any(String),
    );
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true });
  }
});

test('a clean handshake between crashes does not buy a fresh crash budget', async () => {
  const onEvent = jest.fn();
  await mount(onEvent);
  for (let i = 0; i < 4; i++) {
    const el = screen.getByTestId('mentiora-webview');
    await initialize(el);
    await fireEvent(el, 'renderProcessGone', { nativeEvent: { didCrash: true } });
    await advance(9000);
  }
  expect(onEvent).toHaveBeenCalledWith({ type: 'error', code: 'renderer_crashed' });
  expect(screen.getByRole('button', { name: DEFAULT_STRINGS.retry })).toBeTruthy();
});

/** Suspends on first render, so the boundary's children render once, are thrown away, then mount. */
const suspendOnce = () => {
  const state = { done: false };
  let settle!: () => void;
  const gate = new Promise<void>((r) => {
    settle = r;
  });
  const Suspends = (): null => {
    if (!state.done) throw gate;
    return null;
  };
  return {
    Suspends,
    release: () => {
      state.done = true;
      settle();
    },
  };
};

test('a render that never commits leaves no watchdog behind', async () => {
  const onEvent = jest.fn();
  const { Suspends, release } = suspendOnce();
  await render(
    <Suspense fallback={null}>
      <MentioraWidget widgetUrl={WIDGET_URL} onEvent={onEvent} />
      <Suspends />
    </Suspense>,
  );
  await act(async () => {
    release();
  });

  await initialize(screen.getByTestId('mentiora-webview'));
  await advance(20000);
  expect(onEvent).not.toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
});

test("the 8s floor survives StrictMode's simulated unmount", async () => {
  const onEvent = jest.fn();
  await render(
    <StrictMode>
      <MentioraWidget widgetUrl={WIDGET_URL} onEvent={onEvent} />
    </StrictMode>,
  );
  await advance(20000);
  expect(onEvent).toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
});

/** Unmount by re-rendering to `null` under a switch: `screen.unmount()` breaks rendering
 *  for every later test in the file. */
function Mounted({
  show,
  onEvent,
}: {
  show: boolean;
  onEvent: jest.Mock;
}): React.JSX.Element | null {
  return show ? <MentioraWidget widgetUrl={WIDGET_URL} onEvent={onEvent} /> : null;
}

test('an initialize rejecting after unmount never reaches the host', async () => {
  const realCrypto = globalThis.crypto;
  // No host WebCrypto, and nothing answers the round trip, so the handler parks and rejects.
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    const onEvent = jest.fn();
    const view = await render(<Mounted show={true} onEvent={onEvent} />);
    await initialize(screen.getByTestId('mentiora-webview'));
    await act(async () => {
      view.rerender(<Mounted show={false} onEvent={onEvent} />);
    });
    await advance(22000);
    expect(onEvent).not.toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true });
  }
});

test('a signed-in install with no identity answers initialize with -32002, not -32603', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const store = new Map<string, string>([[`mentiora.wasSignedIn.${KEY}`, '1']]);
    const storage = {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: async (k: string) => {
        store.delete(k);
      },
    };
    const view = await render(<MentioraWidget widgetUrl={WIDGET_URL} storage={storage} />);
    await initialize(view.getByTestId('mentiora-webview'));
    await advance(0);
    const codes = sent().map((m) => (m.error as { code?: number } | undefined)?.code);
    expect(codes).toContain(-32002);
    expect(codes).not.toContain(-32603);
  } finally {
    warn.mockRestore();
  }
});

test('a signed-in install with no identity tells the app through identityError', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const onEvent = jest.fn();
    const store = new Map<string, string>([[`mentiora.wasSignedIn.${KEY}`, '1']]);
    const storage = {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: async (k: string) => {
        store.delete(k);
      },
    };
    const view = await render(
      <MentioraWidget widgetUrl={WIDGET_URL} storage={storage} onEvent={onEvent} />,
    );
    await initialize(view.getByTestId('mentiora-webview'));
    await advance(0);
    expect(onEvent).toHaveBeenCalledWith({ type: 'identityError', reason: 'identity_required' });
  } finally {
    warn.mockRestore();
  }
});

test('a signed-in install with no identity says so in dev, and names logout', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const store = new Map<string, string>([[`mentiora.wasSignedIn.${KEY}`, '1']]);
    const storage = {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: async (k: string) => {
        store.delete(k);
      },
    };
    const view = await render(<MentioraWidget widgetUrl={WIDGET_URL} storage={storage} />);
    await initialize(view.getByTestId('mentiora-webview'));
    await advance(0);

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/mentiora identity:.*logout\(\)/s));
  } finally {
    warn.mockRestore();
  }
});
