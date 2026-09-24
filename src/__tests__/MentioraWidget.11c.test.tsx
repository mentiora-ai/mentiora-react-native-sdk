// Insets (`--mw-host-inset-*`) and Android's hardware back button.
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useLayoutEffect } from 'react';
import { BackHandler, Platform, StatusBar } from 'react-native';
import { __lastWebView, __resetWebViews } from '../../__mocks__/react-native-webview';
import {
  __hasValidInsetsForTest,
  __loadSafeAreaInsetsForTest,
  __resolveHostInsetsForTest,
  MentioraWidget,
} from '../MentioraWidget';
import { __resetRuntimes } from '../runtime';
import { DEFAULT_STRINGS } from '../ui/strings';

// Virtual mock of the uninstalled optional peer, the only path injecting `--mw-host-inset-*`
// on Jest's iOS platform. Values are inlined because `jest.mock` factories hoist above every
// statement and may only name `mock*` identifiers.
jest.mock(
  'react-native-safe-area-context',
  () => ({ initialWindowMetrics: { insets: { top: 44, right: 1, bottom: 34, left: 2 } } }),
  { virtual: true },
);

const ORIGIN = 'https://w.x.ai';
const KEY = 'pk_wgt_a';
const WIDGET_URL = `${ORIGIN}/h/rn/${KEY}`;

beforeEach(() => {
  __resetRuntimes();
  __resetWebViews();
});

const sent = (): Record<string, unknown>[] =>
  (__lastWebView().injectJavaScript as jest.Mock).mock.calls
    .map(([script]: [string]) => {
      const m = /window\.mentioraHost\.receive\((.*)\);\s*true;\s*$/s.exec(script as string);
      if (!m) return null;
      return JSON.parse(JSON.parse(m[1] as string) as string) as Record<string, unknown>;
    })
    .filter((m): m is Record<string, unknown> => m !== null);

const handshake = async (el: ReturnType<typeof screen.getByTestId>) => {
  await fireEvent(el, 'message', {
    nativeEvent: {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 'r1',
        method: 'mentiora/initialize',
        params: { protocolVersion: 1 },
      }),
    },
  });
};

// Every send past the handshake carries `params.sessionKey` (peer.ts `withSessionParams`).
const currentSessionKey = (): string => {
  const last = sent().at(-1) as { params?: { sessionKey?: string } } | undefined;
  const key = last?.params?.sessionKey;
  if (typeof key !== 'string') throw new Error('no session key yet — call handshake() first');
  return key;
};

// `false` is also what a keyless page gives, so the stale-hold test must show the key returned.
const peerHasSession = (): boolean => {
  const last = sent().at(-1) as { params?: { sessionKey?: string } } | undefined;
  return typeof last?.params?.sessionKey === 'string';
};

const backHandling = (active: boolean): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'mentiora/backHandling',
    params: { sessionKey: currentSessionKey(), active },
  });

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
  await handshake(el);
  await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
  expect(pressBack()).toBe(true); // handled: we did not dismiss
  expect(sent().at(-1)).toMatchObject({ method: 'mentiora/back' });
});

test('once the page releases it, back is ours again', async () => {
  const el = await mount();
  await handshake(el);
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
  // `jest.spyOn` on a target that is already a `jest.fn()` returns that same reference, so
  // `.mockRestore()` has no original layer and leaves a generic mock with no return value —
  // the next mount crashes on `.remove()`. A fresh `jest.fn()` in `finally` undoes it.
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

// `peer.sessionKey()`, re-checked at press time, releases a button held across a reset.
test('a stale hold intercepts once more before the ladder resets the session key (a known, bounded gap)', async () => {
  const el = await mount();
  await handshake(el);
  await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
  await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
  expect(pressBack()).toBe(true);
});

test("once the ladder's own reload resets the session key, a stale hold no longer intercepts", async () => {
  jest.useFakeTimers();
  try {
    const el = await mount();
    await handshake(el);
    await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
    await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
    await act(async () => jest.advanceTimersByTimeAsync(2000));
    expect(pressBack()).toBe(false);
    // The key returns the instant the new document handshakes, so a `backHeld` surviving the
    // load boundary traps back. Fails without `backHeld.current = false` in `advanceGeneration()`.
    await handshake(el);
    expect(peerHasSession()).toBe(true); // the new page really did handshake
    expect(pressBack()).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

// The watchdog's give-up branch calls `showError` with no `advanceGeneration`, so a slow
// page can still handshake and claim the button behind the error surface, trapping back.
// The `dismissed`/`errorCode` check running first in `onHardwareBack` prevents it.
test('a late handshake after handshake_timeout must not let backHandling trap the user', async () => {
  jest.useFakeTimers();
  try {
    const el = await mount();
    // First timeout: the recovery branch, which does advance the generation.
    await act(async () => jest.advanceTimersByTimeAsync(8000));
    // Second: the cap of 1 is exceeded, so this is the give-up branch.
    await act(async () => jest.advanceTimersByTimeAsync(8000));
    expect(screen.getByRole('button', { name: DEFAULT_STRINGS.retry })).toBeTruthy();
    await handshake(el);
    await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
    expect(pressBack()).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

test('insets are set from safe-area-context when present', async () => {
  await mount();
  const injected = (__lastWebView().injectJavaScript as jest.Mock).mock.calls.map(
    ([s]) => s as string,
  );
  expect(injected.some((s) => s.includes('--mw-host-inset-top'))).toBe(true);
  expect(injected.every((s) => s.trimEnd().endsWith('true;'))).toBe(true);
});

test('we never claim reportsViewport — the page tracks visualViewport itself', async () => {
  // A `reportsViewport` claim could only appear in the `initialize` result, which a
  // mount-only check never produces — so handshake first.
  const el = await mount();
  await handshake(el);
  const injected = (__lastWebView().injectJavaScript as jest.Mock).mock.calls.map(
    ([s]) => s as string,
  );
  expect(injected.some((s) => s.includes('reportsViewport'))).toBe(false);
});

test('the react-native-safe-area-context peer, when installed, is what sets the inset values', async () => {
  // All four sides as exact `setProperty` calls: "44px and 34px appear somewhere" also
  // passes an implementation that swaps top and bottom or never sets right and left.
  await mount();
  const injected = (__lastWebView().injectJavaScript as jest.Mock).mock.calls.map(
    ([s]) => s as string,
  );
  const setsProperty = (name: string, px: number): boolean =>
    injected.some((s) =>
      s.includes(`setProperty(${JSON.stringify(name)}, ${JSON.stringify(`${px}px`)})`),
    );
  expect(setsProperty('--mw-host-inset-top', 44)).toBe(true);
  expect(setsProperty('--mw-host-inset-right', 1)).toBe(true);
  expect(setsProperty('--mw-host-inset-bottom', 34)).toBe(true);
  expect(setsProperty('--mw-host-inset-left', 2)).toBe(true);
});

// Driven through the `__resolveHostInsetsForTest` seam: once the peer has resolved in this
// file's registry, only `jest.resetModules()` invalidates it — discarding React with it.
test('without the peer, Android falls back to StatusBar.currentHeight', () => {
  const realOS = Platform.OS;
  const realHeight = StatusBar.currentHeight;
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  Object.defineProperty(StatusBar, 'currentHeight', { value: 24, configurable: true });
  try {
    expect(__resolveHostInsetsForTest(() => null)).toEqual({
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
    expect(__resolveHostInsetsForTest(() => null)).toBeNull();
  } finally {
    Object.defineProperty(Platform, 'OS', { value: realOS, configurable: true });
  }
});

test('a malformed peer measurement (a shape mismatch, not just absence) is rejected, not interpolated', () => {
  // A non-numeric field interpolates to a valid token ("undefinedpx") that throws
  // nowhere but drops the page's whole padding declaration. `hasValidInsets` guards it.
  expect(__hasValidInsetsForTest({ top: 44, right: 1, bottom: 34, left: 2 })).toBe(true);
  expect(
    __hasValidInsetsForTest({
      top: undefined as unknown as number,
      right: 1,
      bottom: 34,
      left: 2,
    }),
  ).toBe(false);
  expect(__hasValidInsetsForTest({ top: Number.NaN, right: 1, bottom: 34, left: 2 })).toBe(false);
  expect(
    __hasValidInsetsForTest({
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
  expect(__loadSafeAreaInsetsForTest(() => true, malformed as () => unknown)).toBeNull();
  const wellFormed = () => ({
    initialWindowMetrics: { insets: { top: 44, right: 1, bottom: 34, left: 2 } },
  });
  expect(__loadSafeAreaInsetsForTest(() => true, wellFormed as () => unknown)).toEqual({
    top: 44,
    right: 1,
    bottom: 34,
    left: 2,
  });
});

// `ErrorScreen`'s `strings` is reachable only if `MentioraWidgetProps` carries the field.
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
    // The per-key merge is what makes a partial override safe: a plain spread differs
    // only on the keys left out, blanking `dismiss` on a screen that needs its exit.
    expect(screen.getByRole('button', { name: DEFAULT_STRINGS.dismiss })).toBeTruthy();
    expect(screen.getByText(DEFAULT_STRINGS.errorTitle)).toBeTruthy();
    expect(screen.getByText(DEFAULT_STRINGS.errorBody)).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});

// The back registration refreshes in a layout effect: `showError` runs from a timer whose
// passive effects flush a task later, and a sibling's `useLayoutEffect` is inside that gap.
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
