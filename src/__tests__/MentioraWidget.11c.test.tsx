// src/__tests__/MentioraWidget.11c.test.tsx
//
// Task 11c: insets (`--mw-host-inset-*`) and Android's hardware back button —
// the release protocol (`mentiora/backHandling`) and `.remove()` teardown.
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
};

// Every send once a session exists carries `params.sessionKey` (peer.ts's
// `withSessionParams`) — pull it off the last message sent so far.
const currentSessionKey = (): string => {
  const last = sent().at(-1) as { params?: { sessionKey?: string } } | undefined;
  const key = last?.params?.sessionKey;
  if (typeof key !== 'string') throw new Error('no session key yet — call handshake() first');
  return key;
};

// Proof that the assertion below is testing what it claims: a `pressBack()`
// of `false` is also what a page with NO session key gives, so the stale-hold
// test has to show the replacement page's handshake actually landed. Every
// send once a session exists carries the key, so its presence is the proof.
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
  // `jest.setup.ts` assigns `BackHandler.addEventListener` as a plain
  // `jest.fn(...)` (a property overwrite, not a real method) — `jest.spyOn`
  // on a target that is ALREADY a mock function does not wrap it in a new
  // one; it hands back that SAME reference, so `.mockReturnValue` here
  // mutates jest.setup's shared mock in place, and its `.mockRestore()`
  // does not bring back jest.setup's own implementation (there is no
  // separate "original" layer to restore to) — it resets to a generic
  // mock with no return value at all, which the next test to mount a
  // `MentioraWidget` and read the returned subscription's `.remove()`
  // would crash on. Reassigning a fresh, working `jest.fn()` — the exact
  // shape jest.setup.ts itself assigns — in `finally` is what actually
  // undoes this, `jest.config.js` having no `restoreMocks` (confirmed by
  // running this file with and without the reassignment).
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

// Resolution 5 ("back must not become a second way to be trapped"): the page
// claims the button, then a network incident resets the session key
// underneath it (11b's own ladder) with nothing ever telling us the button
// was released. `peer.sessionKey()`, re-checked at PRESS TIME, is what
// unblocks back once that reset has happened for the network/crash ladders
// — but NOT for the handshake watchdog's own give-up branch, which is why
// `onHardwareBack` also checks `dismissed`/`errorCode` first (see the
// mutation-critical test below, and the doc comment on `onHardwareBack`).
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
    // ...and it must STAY ours once the replacement page handshakes (branch
    // review, C1). The check above only proves the window BETWEEN the reset
    // and the next `initialize`: `peer.sessionKey() !== null` is true again
    // the instant the new document completes its handshake, so a `backHeld`
    // that survived the load boundary would be trusted from here on, for a
    // page that sent no `backHandling` at all — every press claimed and
    // forwarded, the Modal never closing. This second handshake is the whole
    // difference; it fails if `backHeld.current = false` is deleted from
    // `advanceGeneration()`.
    await handshake(el);
    expect(peerHasSession()).toBe(true); // the new page really did handshake
    expect(pressBack()).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

// MUTATION-CRITICAL: the handshake watchdog's own give-up branch
// (`armWatchdog`'s `else { showError('handshake_timeout') }`) calls
// `showError` directly, with NO `advanceGeneration` of its own — unlike
// every other terminal branch in 11b. The peer's `initializeLatch` and
// session key are therefore untouched, so a SLOW page (a cold start past
// two 8s watchdog cycles is ordinary, not exotic) can still complete
// `initialize` — the WebView deliberately stays mounted under the overlay
// for exactly this reason, so Retry has something to retry — and be handed
// a live session key AFTER the error surface is already showing. If that
// late page then claims the button, `peer.sessionKey() !== null` alone
// would forward every later back press to a page hidden behind
// `importantForAccessibility="no-hide-descendants"`, with nothing left to
// ever release it (the watchdog is already spent: `HANDSHAKE_RECOVERY_CAP`
// is 1). `dismissed`/`errorCode`, checked FIRST in `onHardwareBack`, are
// what prevent this — this test is the one a mutation deleting that check
// must fail.
test('a late handshake after handshake_timeout must not let backHandling trap the user', async () => {
  jest.useFakeTimers();
  try {
    const el = await mount();
    // First watchdog timeout: one silent, unconditional reload (generation
    // DOES advance here — this is the recovery branch, not the give-up one).
    await act(async () => jest.advanceTimersByTimeAsync(8000));
    // Second watchdog timeout, on the new generation: the cap (1) is
    // exceeded, so this is the give-up branch — `showError` with no
    // `advanceGeneration`.
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
  // The only realistic place this SDK would ever claim `reportsViewport` is
  // inside the `initialize` result (the one message shaped like a capability
  // announcement) — a mount-only check never produces or inspects that
  // message at all, so it would pass unchanged even if a future edit added
  // the claim there. Handshake first.
  const el = await mount();
  await handshake(el);
  const injected = (__lastWebView().injectJavaScript as jest.Mock).mock.calls.map(
    ([s]) => s as string,
  );
  expect(injected.some((s) => s.includes('reportsViewport'))).toBe(false);
});

test('the react-native-safe-area-context peer, when installed, is what sets the inset values', async () => {
  // Exercises the file's default "present" mock (top of file): all FOUR
  // sides, each asserted as its own exact `setProperty(name, "Npx")` call —
  // not just "44px and 34px appear somewhere", which an implementation that
  // swaps top<->bottom (or never sets right/left at all) would pass
  // identically. That swap is the literal "chat mislaid under the notch"
  // failure this property exists to prevent.
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

test('a malformed peer measurement (a shape mismatch, not just absence) is rejected, not interpolated', () => {
  // Interpolating an `undefined`/non-numeric field straight into `${px}px`
  // produces a syntactically VALID custom-property token ("undefinedpx"),
  // so nothing throws — the page's own `max(env(...), var(--mw-host-inset-*))`
  // then fails at computed-value time and drops the whole padding
  // declaration, worse than never setting the property. `hasValidInsets`
  // (inside `loadSafeAreaInsets`, not `resolveHostInsets`) is the guard.
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
  // `hasValidInsets` being correct in isolation does not prove
  // `loadSafeAreaInsets` actually CALLS it — a mutation deleting that one
  // call site is invisible to the test above, which never goes through
  // `loadSafeAreaInsets` at all. `requireModule` is the seam that lets this
  // one exercise the real wiring instead.
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
    // The per-key merge in `ErrorScreen` (Task 10) is what makes a PARTIAL
    // override safe — a regression collapsing it to a plain
    // `{ ...DEFAULT_STRINGS, ...strings }` spread would behave identically
    // for every key actually overridden here, and only show up on the keys
    // that were not: `dismiss` blanking on the one screen whose exit must
    // never go invisible would be invisible to a test that only checks
    // `retry`.
    expect(screen.getByRole('button', { name: DEFAULT_STRINGS.dismiss })).toBeTruthy();
    expect(screen.getByText(DEFAULT_STRINGS.errorTitle)).toBeTruthy();
    expect(screen.getByText(DEFAULT_STRINGS.errorBody)).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});

// --- Re-review, F10 ---
//
// The BackHandler listener and the Modal's `backPress` registration were
// refreshed in a PASSIVE effect. `onHardwareBack` closes over
// `dismissed`/`errorCode`, and `showError` runs from a timer — a non-discrete
// lane whose passive effects flush on the scheduler's next task. A press
// landing in that gap ran the previous closure and, while the page held the
// button, forwarded `mentiora/back` to a page sitting under the error surface
// instead of closing.
//
// React runs EVERY layout effect in a commit before ANY passive effect, so a
// sibling's `useLayoutEffect` is inside the gap by construction: it sees the
// registration only when the widget registers from the commit phase too.
//
// Catches changing the registration's `useLayoutEffect` back to `useEffect`.
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
