// Insets (`--mw-host-inset-*`) and Android's hardware back button: the release
// protocol (`mentiora/backHandling`) and `.remove()` teardown.
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

// `react-native-safe-area-context` is an optional peer this repo does not install,
// so its absence is real. This file's default is "present": a virtual mock, which is
// how Jest mocks a module that is not on disk, scoped to this file's own module
// registry. It is needed because Jest's default test platform is iOS, where this
// peer is the only path that injects `--mw-host-inset-*` at all — the Android
// StatusBar fallback does not apply there.
//
// The factory's value is inlined rather than a named const: `jest.mock` factories are
// hoisted above every other statement in the file, including a `const` directly above
// them, and may only reference identifiers on Jest's allowlist (names starting with
// `mock`).
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

// Completes the handshake so a session key exists and `mentiora/backHandling` is
// not dropped as unauthorized.
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

// Every send once a session exists carries `params.sessionKey` (peer.ts's
// `withSessionParams`) — pull it off the last message sent so far.
const currentSessionKey = (): string => {
  const last = sent().at(-1) as { params?: { sessionKey?: string } } | undefined;
  const key = last?.params?.sessionKey;
  if (typeof key !== 'string') throw new Error('no session key yet — call handshake() first');
  return key;
};

// A `pressBack()` of `false` is also what a page with no session key gives, so the
// stale-hold test has to show the replacement page's handshake landed. Every send
// once a session exists carries the key, so its presence is the proof.
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

// The mock `BackHandler.addEventListener` in jest.setup.ts neither tracks nor
// invokes the registered handler; it returns `{ remove: jest.fn() }`. Pressing back
// means calling the handler this component registered.
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
  // `jest.setup.ts` assigns `BackHandler.addEventListener` as a plain `jest.fn(...)`,
  // a property overwrite rather than a real method. `jest.spyOn` on a target that is
  // already a mock hands back that same reference, so `.mockReturnValue` mutates the
  // shared mock in place and `.mockRestore()` has no original layer to restore: it
  // resets to a generic mock with no return value, and the next test to mount a
  // `MentioraWidget` crashes reading the subscription's `.remove()`. Reassigning a
  // fresh `jest.fn()` in `finally` is what undoes it; `jest.config.js` sets no
  // `restoreMocks`.
  const add = jest
    .spyOn(BackHandler, 'addEventListener')
    .mockReturnValue({ remove } as unknown as ReturnType<typeof BackHandler.addEventListener>);
  try {
    const view = await render(<MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} />);
    expect(add).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
    await view.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
    // `removeEventListener` was deleted in RN 0.77 and calling it throws — the
    // component must never reach for it.
    expect((BackHandler as Record<string, unknown>).removeEventListener).toBeUndefined();
  } finally {
    BackHandler.addEventListener = jest.fn(() => ({ remove: jest.fn() }));
  }
});

// Back must not become a second way to be trapped. The page claims the button, then
// a network incident resets the session key underneath it with nothing telling us the
// button was released. `peer.sessionKey()`, re-checked at press time, unblocks back
// once that reset has happened for the network and crash ladders — but not for the
// handshake watchdog's give-up branch, which is why `onHardwareBack` checks
// `dismissed`/`errorCode` first. The test below owns that case.
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
    // Comfortably past the load ladder's first retry delay (~1s, cap 8s).
    await act(async () => jest.advanceTimersByTimeAsync(2000));
    expect(pressBack()).toBe(false);
    // It must stay ours once the replacement page handshakes. The check above only
    // covers the window between the reset and the next `initialize`:
    // `peer.sessionKey() !== null` is true again the instant the new document
    // handshakes, so a `backHeld` surviving the load boundary would be trusted from
    // here on for a page that sent no `backHandling` at all — every press claimed
    // and forwarded, the Modal never closing. Fails if `backHeld.current = false` is
    // dropped from `advanceGeneration()`.
    await handshake(el);
    expect(peerHasSession()).toBe(true); // the new page really did handshake
    expect(pressBack()).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

// The handshake watchdog's give-up branch (`armWatchdog`'s
// `else { showError('handshake_timeout') }`) calls `showError` directly with no
// `advanceGeneration`, unlike every other terminal branch. The peer's
// `initializeLatch` and session key are untouched, so a slow page — a cold start past
// two 8s watchdog cycles is ordinary — can still complete `initialize` and be handed
// a live session key after the error surface is showing. The WebView stays mounted
// under the overlay so Retry has something to retry. If that late page claims the
// button, `peer.sessionKey() !== null` alone forwards every later back press to a
// page hidden behind `importantForAccessibility="no-hide-descendants"`, with nothing
// left to release it: the watchdog is spent, `HANDSHAKE_RECOVERY_CAP` being 1. The
// `dismissed`/`errorCode` check that runs first in `onHardwareBack` is what prevents
// it, and this test is what fails when that check goes.
test('a late handshake after handshake_timeout must not let backHandling trap the user', async () => {
  jest.useFakeTimers();
  try {
    const el = await mount();
    // First watchdog timeout: one silent, unconditional reload. The generation does
    // advance here — this is the recovery branch, not the give-up one.
    await act(async () => jest.advanceTimersByTimeAsync(8000));
    // Second watchdog timeout, on the new generation: the cap of 1 is exceeded, so
    // this is the give-up branch — `showError` with no `advanceGeneration`.
    await act(async () => jest.advanceTimersByTimeAsync(8000));
    expect(screen.getByRole('button', { name: DEFAULT_STRINGS.retry })).toBeTruthy();
    // The slow page finally speaks, well after the error surface appeared.
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
  // The one message shaped like a capability announcement is the `initialize`
  // result, so that is where a `reportsViewport` claim would appear. A mount-only
  // check never produces it and would pass even once the claim was added. Handshake
  // first.
  const el = await mount();
  await handshake(el);
  const injected = (__lastWebView().injectJavaScript as jest.Mock).mock.calls.map(
    ([s]) => s as string,
  );
  expect(injected.some((s) => s.includes('reportsViewport'))).toBe(false);
});

test('the react-native-safe-area-context peer, when installed, is what sets the inset values', async () => {
  // Exercises the file's default "present" mock. All four sides, each as its own
  // exact `setProperty(name, "Npx")` call: "44px and 34px appear somewhere" passes
  // identically for an implementation that swaps top and bottom, or never sets right
  // and left, which is the chat-under-the-notch failure this property prevents.
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

// The next two drive `resolveHostInsets`'s branches through the test-only
// `__resolveHostInsetsForTest` hook rather than a component render. Once
// `require('react-native-safe-area-context')` has resolved in this file's module
// registry it sticks: `jest.doMock` does not invalidate an already-resolved module
// without `jest.resetModules()`, which would also discard React for this file's
// already-rendered tests. Passing `load` in sidesteps that, which is what the seam
// is for.
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
  // iOS with no peer needs nothing injected, and that has to be an actual `null`,
  // not a `0` standing in for one.
  const realOS = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  try {
    expect(__resolveHostInsetsForTest(() => null)).toBeNull();
  } finally {
    Object.defineProperty(Platform, 'OS', { value: realOS, configurable: true });
  }
});

test('a malformed peer measurement (a shape mismatch, not just absence) is rejected, not interpolated', () => {
  // Interpolating an undefined or non-numeric field into `${px}px` produces a
  // syntactically valid custom-property token ("undefinedpx"), so nothing throws.
  // The page's `max(env(...), var(--mw-host-inset-*))` then fails at computed-value
  // time and drops the whole padding declaration, which is worse than never setting
  // the property. `hasValidInsets`, inside `loadSafeAreaInsets`, is the guard.
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
  // `hasValidInsets` being correct in isolation does not prove `loadSafeAreaInsets`
  // calls it, and the test above never goes through `loadSafeAreaInsets` at all.
  // `requireModule` is the seam that exercises the wiring.
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

// `strings` on `ErrorScreen` is only reachable if `MentioraWidgetProps` carries a
// `strings` field; without one a host override is dead on arrival.
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
    // The per-key merge in `ErrorScreen` is what makes a partial override safe.
    // Collapsing it to a plain `{ ...DEFAULT_STRINGS, ...strings }` spread behaves
    // identically for every key overridden here and shows up only on the keys that
    // are not — `dismiss` blanking on the one screen whose exit must stay visible.
    expect(screen.getByRole('button', { name: DEFAULT_STRINGS.dismiss })).toBeTruthy();
    expect(screen.getByText(DEFAULT_STRINGS.errorTitle)).toBeTruthy();
    expect(screen.getByText(DEFAULT_STRINGS.errorBody)).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});

// The BackHandler listener and the Modal's `backPress` registration refresh in a
// layout effect, not a passive one. `onHardwareBack` closes over
// `dismissed`/`errorCode`, and `showError` runs from a timer — a non-discrete lane
// whose passive effects flush on the scheduler's next task. A press landing in that
// gap runs the previous closure and, while the page holds the button, forwards
// `mentiora/back` to a page sitting under the error surface instead of closing.
//
// React runs every layout effect in a commit before any passive effect, so a
// sibling's `useLayoutEffect` is inside that gap by construction: it sees the
// registration only if the widget registers from the commit phase too.
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
      <MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} />
      <Probe />
    </>,
  );
  expect(registeredByLayoutTime).toBe(1);
});
