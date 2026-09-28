import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useLayoutEffect } from 'react';
import { BackHandler, Platform, StatusBar } from 'react-native';
import { __lastWebView, __resetWebViews } from '../../__mocks__/react-native-webview';
import { ThreadChannelContext } from '../channels';
import {
  hasValidInsets,
  loadSafeAreaInsets,
  loadSafeAreaListener,
  resolveHostInsets,
} from '../insets';
import { MentioraWidget } from '../MentioraWidget';
import { __resetRuntimes } from '../runtime';
import { DEFAULT_STRINGS } from '../ui/strings';
import { backHandling, initialize, sent, WIDGET_URL } from './helpers';

// Virtual mock of the optional peer. Values are inlined because `jest.mock` factories
// hoist and may only name `mock*` identifiers.
jest.mock(
  'react-native-safe-area-context',
  () => {
    const { createElement } = require('react');
    const { View } = require('react-native');
    return {
      initialWindowMetrics: { insets: { top: 44, right: 1, bottom: 34, left: 2 } },
      SafeAreaListener: (props: object) =>
        createElement(View, { ...props, testID: 'safe-area-listener' }),
    };
  },
  { virtual: true },
);

const onPlatform = async (os: 'ios' | 'android', run: () => Promise<void>): Promise<void> => {
  const real = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  try {
    await run();
  } finally {
    Object.defineProperty(Platform, 'OS', { value: real, configurable: true });
  }
};

const injectedScripts = (): string[] =>
  (__lastWebView().injectJavaScript as jest.Mock).mock.calls.map(([s]) => s as string);

const setsProperty = (name: string, px: number): boolean =>
  injectedScripts().some((s) =>
    s.includes(`setProperty(${JSON.stringify(name)}, ${JSON.stringify(`${px}px`)})`),
  );

beforeEach(() => {
  __resetRuntimes();
  __resetWebViews();
});

// `false` is also what a keyless page gives, so the stale-hold test must show the key returned.
const peerHasSession = (): boolean => {
  const last = sent().at(-1) as { params?: { sessionKey?: string } } | undefined;
  return typeof last?.params?.sessionKey === 'string';
};

// The jest.setup.ts mock never invokes the registered handler, so pressing back
// means calling the handler this component registered.
const pressBack = (): boolean => {
  const add = BackHandler.addEventListener as jest.Mock;
  const call = add.mock.calls.at(-1);
  if (!call) throw new Error('MentioraWidget never registered a hardwareBackPress handler');
  const handler = call[1] as () => boolean;
  return handler();
};

const mount = async () => {
  await render(<MentioraWidget widgetUrl={WIDGET_URL} />);
  return screen.getByTestId('mentiora-webview');
};

test('back is forwarded to the page while it holds the button', async () => {
  const el = await mount();
  await initialize(el);
  await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
  expect(pressBack()).toBe(true); // handled: we did not dismiss
  expect(sent().at(-1)).toMatchObject({ method: 'mentiora/back' });
});

test('once the page releases it, back is ours again', async () => {
  const el = await mount();
  await initialize(el);
  await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
  await fireEvent(el, 'message', { nativeEvent: { data: backHandling(false) } });
  expect(pressBack()).toBe(false); // unhandled: the host dismisses
});

test('back is unhandled by default — the page never claimed it', async () => {
  await mount();
  expect(pressBack()).toBe(false);
});

test('the BackHandler subscription is removed with .remove(), not removeEventListener', async () => {
  const remove = jest.fn();
  // `spyOn` on an existing `jest.fn()` returns that same mock, so `.mockRestore()` leaves one
  // with no return value and the next mount crashes on `.remove()`.
  const add = jest
    .spyOn(BackHandler, 'addEventListener')
    .mockReturnValue({ remove } as unknown as ReturnType<typeof BackHandler.addEventListener>);
  try {
    const view = await render(<MentioraWidget widgetUrl={WIDGET_URL} />);
    expect(add).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
    await view.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
    // `removeEventListener` was deleted in RN 0.77 and throws if called.
    expect((BackHandler as unknown as Record<string, unknown>).removeEventListener).toBeUndefined();
  } finally {
    BackHandler.addEventListener = jest.fn(() => ({ remove: jest.fn() }));
  }
});

test('a stale hold intercepts once more before the ladder resets the session key (a known, bounded gap)', async () => {
  const el = await mount();
  await initialize(el);
  await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
  await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
  expect(pressBack()).toBe(true);
});

test("once the ladder's own reload resets the session key, a stale hold no longer intercepts", async () => {
  jest.useFakeTimers();
  try {
    const el = await mount();
    await initialize(el);
    await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
    await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
    await act(async () => jest.advanceTimersByTimeAsync(2000));
    expect(pressBack()).toBe(false);
    // Fails without `backHeld.current = false` in `advanceGeneration()`.
    await initialize(el);
    expect(peerHasSession()).toBe(true); // the new page really did handshake
    expect(pressBack()).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

test('a late handshake after handshake_timeout must not let backHandling trap the user', async () => {
  jest.useFakeTimers();
  try {
    const el = await mount();
    // First timeout: the recovery branch, which does advance the generation.
    await act(async () => jest.advanceTimersByTimeAsync(8000));
    // Second: the cap of 1 is exceeded, so this is the give-up branch.
    await act(async () => jest.advanceTimersByTimeAsync(8000));
    expect(screen.getByRole('button', { name: DEFAULT_STRINGS.retry })).toBeTruthy();
    await initialize(el);
    await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
    expect(pressBack()).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

test('on Android, insets are set from safe-area-context when present', async () => {
  await onPlatform('android', async () => {
    await mount();
    const injected = injectedScripts();
    expect(injected.some((s) => s.includes('--mw-host-inset-top'))).toBe(true);
    expect(injected.every((s) => s.trimEnd().endsWith('true;'))).toBe(true);
  });
});

test("on iOS, no insets are pushed: WKWebView's env() already covers only this view", async () => {
  await onPlatform('ios', async () => {
    const el = await mount();
    await fireEvent(el, 'loadEnd');
    expect(injectedScripts().some((s) => s.includes('--mw-host-inset'))).toBe(false);
    expect(screen.queryByTestId('safe-area-listener')).toBeNull();
  });
});

test('on Android, the per-view overlap replaces the window insets, and a reload re-sends it', async () => {
  await onPlatform('android', async () => {
    const el = await mount();
    await fireEvent(screen.getByTestId('safe-area-listener'), 'change', {
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    (__lastWebView().injectJavaScript as jest.Mock).mockClear();
    await fireEvent(el, 'loadEnd');
    expect(setsProperty('--mw-host-inset-top', 0)).toBe(true);
    expect(setsProperty('--mw-host-inset-bottom', 0)).toBe(true);
    expect(setsProperty('--mw-host-inset-top', 44)).toBe(false);
    expect(injectedScripts().some((s) => s.includes('"data-host-insets", "view"'))).toBe(true);
  });
});

test('on Android, window insets are not marked per-view, so the page keeps max() with env()', async () => {
  await onPlatform('android', async () => {
    await mount();
    expect(injectedScripts().some((s) => s.includes('"data-host-insets", "window"'))).toBe(true);
    expect(injectedScripts().some((s) => s.includes('"data-host-insets", "view"'))).toBe(false);
  });
});

test('on Android, the overlay inside MentioraHost uses window insets, not the listener', async () => {
  await onPlatform('android', async () => {
    await render(
      <ThreadChannelContext.Provider value={{ take: () => null, subscribe: () => () => {} }}>
        <MentioraWidget widgetUrl={WIDGET_URL} />
      </ThreadChannelContext.Provider>,
    );
    expect(screen.queryByTestId('safe-area-listener')).toBeNull();
    expect(setsProperty('--mw-host-inset-top', 44)).toBe(true);
  });
});

test('on Android, a malformed listener measurement keeps the last good insets', async () => {
  await onPlatform('android', async () => {
    const el = await mount();
    await fireEvent(screen.getByTestId('safe-area-listener'), 'change', {
      insets: { top: Number.NaN, right: 0, bottom: 0, left: 0 },
    });
    (__lastWebView().injectJavaScript as jest.Mock).mockClear();
    await fireEvent(el, 'loadEnd');
    expect(setsProperty('--mw-host-inset-top', 44)).toBe(true);
  });
});

test('we never claim reportsViewport — the page tracks visualViewport itself', async () => {
  // A `reportsViewport` claim could only appear in the `initialize` result, which a
  // mount-only check never produces — so handshake first.
  const el = await mount();
  await initialize(el);
  const injected = (__lastWebView().injectJavaScript as jest.Mock).mock.calls.map(
    ([s]) => s as string,
  );
  expect(injected.some((s) => s.includes('reportsViewport'))).toBe(false);
});

test('on Android, the react-native-safe-area-context peer is what sets the first inset values', async () => {
  // All four sides as exact `setProperty` calls: "44px and 34px appear somewhere" also
  // passes an implementation that swaps top and bottom or never sets right and left.
  await onPlatform('android', async () => {
    await mount();
    expect(setsProperty('--mw-host-inset-top', 44)).toBe(true);
    expect(setsProperty('--mw-host-inset-right', 1)).toBe(true);
    expect(setsProperty('--mw-host-inset-bottom', 34)).toBe(true);
    expect(setsProperty('--mw-host-inset-left', 2)).toBe(true);
  });
});

test('loadSafeAreaListener returns null for a peer older than 5.5, which has no SafeAreaListener', () => {
  const old = () => ({ initialWindowMetrics: null });
  expect(loadSafeAreaListener(() => true, old)).toBeNull();
  expect(loadSafeAreaListener(() => false)).toBeNull();
});

// Driven through the `resolveHostInsets` seam: once the peer has resolved in this
// file's registry, only `jest.resetModules()` invalidates it — discarding React with it.
test('without the peer, Android falls back to StatusBar.currentHeight', () => {
  const realOS = Platform.OS;
  const realHeight = StatusBar.currentHeight;
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  Object.defineProperty(StatusBar, 'currentHeight', { value: 24, configurable: true });
  try {
    expect(resolveHostInsets(() => null)).toEqual({
      top: 24,
      right: 0,
      bottom: 0,
      left: 0,
    });
  } finally {
    Object.defineProperty(Platform, 'OS', { value: realOS, configurable: true });
    Object.defineProperty(StatusBar, 'currentHeight', { value: realHeight, configurable: true });
  }
});

test('with neither the peer nor Android, nothing is measurable — null, not a fabricated 0', () => {
  const realOS = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  try {
    expect(resolveHostInsets(() => null)).toBeNull();
  } finally {
    Object.defineProperty(Platform, 'OS', { value: realOS, configurable: true });
  }
});

test('a malformed peer measurement (a shape mismatch, not just absence) is rejected, not interpolated', () => {
  // A non-numeric field interpolates to a valid token ("undefinedpx") that throws
  // nowhere but drops the page's whole padding declaration. `hasValidInsets` guards it.
  expect(hasValidInsets({ top: 44, right: 1, bottom: 34, left: 2 })).toBe(true);
  expect(
    hasValidInsets({
      top: undefined as unknown as number,
      right: 1,
      bottom: 34,
      left: 2,
    }),
  ).toBe(false);
  expect(hasValidInsets({ top: Number.NaN, right: 1, bottom: 34, left: 2 })).toBe(false);
  expect(
    hasValidInsets({
      top: 'not a number' as unknown as number,
      right: 1,
      bottom: 34,
      left: 2,
    }),
  ).toBe(false);
});

test('a malformed peer measurement is rejected by loadSafeAreaInsets ITSELF, not only by the predicate', () => {
  // The test above never goes through `loadSafeAreaInsets`; `requireModule` is that seam.
  const malformed = () => ({
    initialWindowMetrics: { insets: { top: undefined, right: 1, bottom: 34, left: 2 } },
  });
  expect(loadSafeAreaInsets(() => true, malformed as () => unknown)).toBeNull();
  const wellFormed = () => ({
    initialWindowMetrics: { insets: { top: 44, right: 1, bottom: 34, left: 2 } },
  });
  expect(loadSafeAreaInsets(() => true, wellFormed as () => unknown)).toEqual({
    top: 44,
    right: 1,
    bottom: 34,
    left: 2,
  });
});

test('a strings override on the public config reaches the rendered error screen', async () => {
  jest.useFakeTimers();
  try {
    await render(<MentioraWidget widgetUrl={WIDGET_URL} strings={{ retry: 'Try again' }} />);
    const el = screen.getByTestId('mentiora-webview');
    for (let i = 0; i < 3; i++) {
      await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
      await act(async () => jest.advanceTimersByTimeAsync(9000));
    }
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: DEFAULT_STRINGS.retry })).toBeNull();
    expect(screen.getByRole('button', { name: DEFAULT_STRINGS.dismiss })).toBeTruthy();
    expect(screen.getByText(DEFAULT_STRINGS.errorTitle)).toBeTruthy();
    expect(screen.getByText(DEFAULT_STRINGS.errorBody)).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});

test('the back registration lands in the commit, not in the passive flush', async () => {
  const add = BackHandler.addEventListener as jest.Mock;
  add.mockClear();
  let registeredByLayoutTime = 0;
  function Probe(): null {
    useLayoutEffect(() => {
      registeredByLayoutTime = add.mock.calls.length;
    }, []);
    return null;
  }
  await render(
    <>
      <MentioraWidget widgetUrl={WIDGET_URL} />
      <Probe />
    </>,
  );
  expect(registeredByLayoutTime).toBe(1);
});
