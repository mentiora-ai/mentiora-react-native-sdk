// src/__tests__/MentioraWidget.11c.test.tsx
//
// Task 11c: insets (`--mw-host-inset-*`) and Android's hardware back button —
// the release protocol (`mentiora/backHandling`) and `.remove()` teardown.
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { BackHandler, Platform, StatusBar } from 'react-native';
import { __lastWebView, __resetWebViews } from '../../__mocks__/react-native-webview';
import { __resolveHostInsetsForTest, MentioraWidget } from '../MentioraWidget';
import { RANDOM_REPLY_TAG } from '../random';
import { __resetRuntimes } from '../runtime';
import { DEFAULT_STRINGS } from '../ui/strings';

// `react-native-safe-area-context` is an optional peer this package does not
// depend on and this repo does not install — real absence, exercised as-is
// by every test below except where a test says otherwise. This file's
// DEFAULT is "present" (a virtual mock — Jest allows mocking a module that
// does not exist on disk this way; it applies only within this test FILE's
// own module registry, never 11a's or 11b's), because Jest's own default
// test platform is iOS (`Platform.OS === 'ios'`, verified against this
// project's own jest config), where the ONLY way `--mw-host-inset-*` is
// ever injected at all is through this peer — the Android StatusBar
// fallback does not apply on iOS, and there is no third path.
// Inlined (not a named const above): `jest.mock` factories are hoisted above
// every other statement in the file, including a `const` just above them, so
// a factory may only reference identifiers Jest's hoist allowlist covers
// (names starting with `mock`) — a plain literal sidesteps the question.
jest.mock(
  'react-native-safe-area-context',
  () => ({ initialWindowMetrics: { insets: { top: 44, right: 1, bottom: 34, left: 2 } } }),
  { virtual: true },
);

const ORIGIN = 'https://w.x.ai';
const KEY = 'pk_wgt_a';

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

// Completes the same random handshake 11a/11b use, so a session key exists
// and `mentiora/backHandling` is not dropped as unauthorized.
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
  await fireEvent(el, 'message', {
    nativeEvent: { data: JSON.stringify({ tag: RANDOM_REPLY_TAG, bytes: Array(16).fill(7) }) },
  });
};

// Every send once a session exists carries `params.sessionKey` (peer.ts's
// `withSessionParams`) — pull it off the last message sent so far.
const currentSessionKey = (): string => {
  const last = sent().at(-1) as { params?: { sessionKey?: string } } | undefined;
  const key = last?.params?.sessionKey;
  if (typeof key !== 'string') throw new Error('no session key yet — call handshake() first');
  return key;
};

const backHandling = (active: boolean): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'mentiora/backHandling',
    params: { sessionKey: currentSessionKey(), active },
  });

// The mock BackHandler.addEventListener (jest.setup.ts) does not itself track
// or invoke the registered handler — it just returns `{ remove: jest.fn() }`.
// Pressing back means calling the handler this component registered.
const pressBack = (): boolean => {
  const add = BackHandler.addEventListener as jest.Mock;
  const call = add.mock.calls.at(-1);
  if (!call) throw new Error('MentioraWidget never registered a hardwareBackPress handler');
  const handler = call[1] as () => boolean;
  return handler();
};

const mount = async () => {
  await render(<MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} />);
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
  const add = jest
    .spyOn(BackHandler, 'addEventListener')
    .mockReturnValue({ remove } as unknown as ReturnType<typeof BackHandler.addEventListener>);
  const view = await render(<MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} />);
  expect(add).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
  await view.unmount();
  expect(remove).toHaveBeenCalledTimes(1);
  // `removeEventListener` was deleted in RN 0.77 and calling it throws — the
  // component must never reach for it.
  expect((BackHandler as Record<string, unknown>).removeEventListener).toBeUndefined();
});

// Resolution 5 ("back must not become a second way to be trapped"): the page
// claims the button, then a network incident resets the session key
// underneath it (11b's own ladder) with nothing ever telling us the button
// was released. `peer.sessionKey()`, re-checked at PRESS TIME, is what
// unblocks back once that reset has happened — not a separate `errorCode`
// check (tried first, then removed: every reachable way `errorCode` becomes
// non-null already has `sessionKey() === null` by then, given 11b's own
// "reset every ladder on a successful handshake" rule, so it never once
// failed under mutation — see the doc comment on `onHardwareBack`).
test('a stale hold intercepts once more before the ladder resets the session key (a known, bounded gap)', async () => {
  const el = await mount();
  await handshake(el);
  await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
  await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
  // The incident is recorded, but `scheduleRecovery`'s own timer — the thing
  // that actually resets the session key — has not fired yet.
  expect(pressBack()).toBe(true);
});

test("once the ladder's own reload resets the session key, a stale hold no longer intercepts", async () => {
  jest.useFakeTimers();
  try {
    const el = await mount();
    await handshake(el);
    await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
    await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
    // The load ladder's first retry delay (~1s, cap 8s) — comfortably past it.
    await act(async () => jest.advanceTimersByTimeAsync(2000));
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
  await mount();
  const injected = (__lastWebView().injectJavaScript as jest.Mock).mock.calls.map(
    ([s]) => s as string,
  );
  expect(injected.some((s) => s.includes('reportsViewport'))).toBe(false);
});

test('the react-native-safe-area-context peer, when installed, is what sets the inset values', async () => {
  // Exercises the file's default "present" mock (top of file) — the actual
  // numbers it supplies (44/1/34/2), not just the property name, prove this
  // path (not the Android fallback, not "nothing") is what ran.
  await mount();
  const injected = (__lastWebView().injectJavaScript as jest.Mock).mock.calls.map(
    ([s]) => s as string,
  );
  expect(injected.some((s) => s.includes('44px'))).toBe(true);
  expect(injected.some((s) => s.includes('34px'))).toBe(true);
});

// The next two exercise `resolveHostInsets`'s OWN branch logic directly
// (the test-only `__resolveHostInsetsForTest` hook, mirroring `runtime.ts`'s
// `__resetRuntimes`), rather than through a full component render: a real
// `require('react-native-safe-area-context')` succeeding once in this
// file's module registry (the "present" mock above) makes it stick for the
// rest of the file — `jest.doMock` alone does not invalidate an
// already-resolved module without `jest.resetModules()`, which would also
// discard React itself for this file's already-rendered tests. Calling the
// function with an injected `load` sidesteps that entirely, and is exactly
// what the seam is for (`storage.ts`'s `resolveStorage(override, load)` is
// tested the same way).
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
  // iOS with no peer: "iOS needs nothing from us" (design.md §2.7), verified
  // as an actual `null` (nothing to inject), not a `0` standing in for one.
  const realOS = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  try {
    expect(__resolveHostInsetsForTest(() => null)).toBeNull();
  } finally {
    Object.defineProperty(Platform, 'OS', { value: realOS, configurable: true });
  }
});

// Add-on from 11b's review: `strings` existed on `ErrorScreen` (Task 10) but
// had no way to reach it from the public config — `MentioraWidgetProps` had
// no `strings` field, so a host override was dead on arrival.
test('a strings override on the public config reaches the rendered error screen', async () => {
  jest.useFakeTimers();
  try {
    await render(
      <MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} strings={{ retry: 'Try again' }} />,
    );
    const el = screen.getByTestId('mentiora-webview');
    for (let i = 0; i < 3; i++) {
      await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
      await act(async () => jest.advanceTimersByTimeAsync(9000));
    }
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: DEFAULT_STRINGS.retry })).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});
