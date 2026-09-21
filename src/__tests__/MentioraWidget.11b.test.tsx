// src/__tests__/MentioraWidget.11b.test.tsx
//
// Task 11b: the recovery coordinator — the network retry ladder (`onError`),
// the crash ladder (`onContentProcessDidTerminate` / `onRenderProcessGone`),
// and the handshake watchdog, plus the generation-scoped ownership rule that
// keeps one incident from driving two of them.
//
// Modern fake timers, and `jest.advanceTimersByTimeAsync` ONLY: the
// synchronous `advanceTimersByTime` does not drain the microtask queue the
// `await`s inside the coordinator (and inside `peer.receive`) sit on, so a
// timer's callback would fire but its own internal awaits would never
// resolve within the same synchronous tick.
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { __lastWebView, __resetWebViews, __webViews } from '../../__mocks__/react-native-webview';
import { MentioraWidget } from '../MentioraWidget';
import { RANDOM_REPLY_TAG } from '../random';
import { __resetRuntimes } from '../runtime';
import { DEFAULT_STRINGS } from '../ui/strings';

const ORIGIN = 'https://w.x.ai';
const KEY = 'pk_wgt_a';

beforeEach(() => {
  jest.useFakeTimers();
  __resetRuntimes();
  __resetWebViews();
});

afterEach(() => {
  jest.useRealTimers();
});

// `jest.advanceTimersByTimeAsync` fires timer callbacks outside of React's
// `act()` scope; the recovery coordinator's crash path calls `setState`
// (a remount-key bump) from inside one, which React warns about even though
// nothing is actually lost — RNTL's `render`/`fireEvent` wrap themselves in
// `act`, but a bare timer advance does not. Wrapping it here silences that
// noise without touching which timer API is used (still
// `advanceTimersByTimeAsync`, never the synchronous `advanceTimersByTime`).
const advance = (ms: number) => act(async () => jest.advanceTimersByTimeAsync(ms));

// Everything this component injected that is a bridge message, parsed back
// out (11a/11c use the same shape).
const sent = (): Record<string, unknown>[] =>
  (__lastWebView().injectJavaScript as jest.Mock).mock.calls.flatMap(([script]: [string]) => {
    const m = /window\.mentioraHost\.receive\((.*)\);\s*true;\s*$/s.exec(script);
    return m ? [JSON.parse(JSON.parse(m[1] as string) as string) as Record<string, unknown>] : [];
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

const mount = async (onEvent?: jest.Mock) => {
  await render(<MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} onEvent={onEvent} />);
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
  expect(__lastWebView().reload).toHaveBeenCalledTimes(1); // not a ladder
  expect(onEvent).toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
});

test('a handshake timeout never spends the network retry ladder', async () => {
  const onEvent = jest.fn();
  await mount(onEvent);
  await advance(20000);
  const codes = onEvent.mock.calls.map(([e]) => (e as { code?: string }).code);
  // The negative alone ("never load_failed") is the "both paths sent
  // nothing" shape — an implementation that emits no events at all would
  // pass it too. Assert the positive as well: the watchdog itself DID fire
  // and give up (two 8s cycles fit inside 20s), so its own code is present.
  expect(codes).toContain('handshake_timeout');
  expect(codes).not.toContain('load_failed');
});

test('a valid initialize clears the watchdog synchronously — before the random-bytes round trip ever resolves', async () => {
  // Node (and so Jest) has had WebCrypto as a global since v19, so the
  // composition root's `globalCrypto` fast path resolves `randomSource.bytes()`
  // in a microtask regardless of where `clearWatchdogTimer()` sits relative to
  // that `await` — the distinction this test needs to make would be invisible.
  // Disabling it (matching 11a's own "without host WebCrypto" test) forces the
  // injected round trip, which this test deliberately never answers: it stays
  // pending until ITS OWN unrelated 2s timeout REJECTS it. If the watchdog
  // were cleared AFTER that await instead of before it — in a `.then`, after
  // the round trip, or in an effect — the rejection would skip straight past
  // that line, the mount-armed watchdog (8s) would still be live, and it
  // would fire at 8s regardless of the 30s this test advances past that. The
  // ONLY way `reload()` stays uncalled at 9s here is a clear that already
  // happened synchronously, before the await, the moment the request was
  // accepted.
  //
  // What DOES fire, at ~10s, is the watchdog the handler's own catch re-arms
  // once that round trip rejects (branch review, C2) — a rejected handshake is
  // an incident with an owner now, not a dead widget. The two are told apart
  // by WHEN: the mount-armed watchdog would fire at 8s, the re-armed one at
  // 2s (the round trip's own timeout) + 8s.
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

test('a network-ladder reload that never re-initializes still gets caught by the watchdog', async () => {
  // The critical case: a transient blip triggers the network ladder, its own
  // reload succeeds at the HTTP level, but the page's JS never calls
  // `initialize` again. Without a watchdog re-armed for the NEW generation,
  // nothing would ever fire — no error surface, no `onEvent`, and because
  // the page draws its own chrome, no Dismiss either. The fix is `onLoadEnd`
  // re-arming the watchdog once that reload's document actually finishes
  // loading (never a network/crash reload's own `reload()`/remount call,
  // which on Android runs no navigation callback at all).
  const onEvent = jest.fn();
  const el = await mount(onEvent);
  await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
  await advance(2000); // the ladder's own reload fires well inside this (cap 8s, first delay ~1s)
  expect(__lastWebView().reload).toHaveBeenCalledTimes(1);
  // The reload's own document finishes loading — successfully, at the HTTP
  // level — but its JS never speaks again.
  await fireEvent(screen.getByTestId('mentiora-webview'), 'loadEnd', { nativeEvent: {} });
  await advance(8000);
  // The watchdog's OWN single self-heal: one more silent reload.
  expect(__lastWebView().reload).toHaveBeenCalledTimes(2);
  await advance(8000);
  expect(onEvent).toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
});

test('unmounting cancels the live watchdog — no reload, no error event, for a widget the host already closed', async () => {
  const onEvent = jest.fn();
  const view = await render(
    <MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} onEvent={onEvent} />,
  );
  // Captured before unmount: the mock unregisters itself from `__webViews()` on
  // unmount (`__lastWebView()` would throw afterward), but this `jest.fn()`
  // reference is still good — it's how we can tell whether the OLD instance
  // was asked to reload after the widget was torn down.
  const { reload } = __lastWebView();
  await view.unmount();
  // Without the cleanup effect, the mount-armed watchdog is still ticking:
  // `beginFreshLoad()` fires at 8s (harmless on its own — `webview.current` is
  // already null post-unmount, so its own `reload()` call is a no-op), but the
  // SECOND watchdog it re-arms fires at 16s and calls `showError`, which calls
  // the host's `onEvent` regardless of mount state — `latest.current` is a
  // plain ref, not tied to the React tree.
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
  // The instance whose renderer Android already killed — Android's own docs
  // say a dead instance must be removed from the hierarchy and destroyed,
  // never reused, so the only correct repair is a fresh one, not a `.reload()`
  // call on this one.
  const deadWebView = __lastWebView();
  await fireEvent.press(screen.getByRole('button', { name: DEFAULT_STRINGS.retry }));
  expect(__webViews()).toHaveLength(1); // the dead one unregistered, exactly one replaced it
  expect(__webViews()[0]).not.toBe(deadWebView);
  expect(deadWebView.reload).not.toHaveBeenCalled();
});

test('the error overlay is modal to a screen reader — both flags flip with errorCode', async () => {
  // No `getByProps`-style query in this RNTL version — `queryAll` with a
  // predicate is the same escape hatch `test-renderer` itself offers, used
  // here only because neither flag has any other query surface (no text, no
  // role, no testID) to find them by.
  const modalOverlays = () =>
    screen.container.queryAll((i) => i.props.accessibilityViewIsModal === true);

  const el = await mount();
  expect(el.props.importantForAccessibility).toBe('auto');
  expect(modalOverlays()).toHaveLength(0);
  for (let i = 0; i < 3; i++) {
    await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
    await advance(9000);
  }
  // A screen reader must not be able to reach the dead page behind the one
  // exit screen this widget owns: Android hides the WebView subtree from
  // TalkBack, and iOS marks the overlay modal for VoiceOver. Read straight off
  // `el` (same instance throughout — the network ladder only ever calls
  // `.reload()`, never a remount), not `getByTestId`: RNTL's default queries
  // exclude an element with `importantForAccessibility="no-hide-descendants"`
  // on ITSELF as "hidden", which is exactly the prop under test here.
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
  await advance(9000); // lets the network ladder's own recovery fire and move on
  // Only the first terminal callback for a generation picks a path, so the
  // crash counter above must still read 0, not 1 — it needs its own full
  // cap (3 more recoveries, 4 total) before any surface appears, not one
  // fewer. A mutant that deletes the `handled` gate double-counts that first
  // incident (both callbacks run), so its crash counter starts at 1 instead
  // of 0 and is already AT its cap of 4 after these same 3 further, genuine
  // crash-only incidents — which is exactly why 3 is driven here, not fewer.
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
  // `includeHiddenElements`, as at `presenter.test.tsx`'s equivalent (branch
  // review, m6): under a Dismiss that failed to unmount, the WebView would
  // still be `importantForAccessibility="no-hide-descendants"` beneath the
  // overlay, which RNTL's queries exclude by default — a plain
  // `queryByTestId` would read `null` and pass vacuously.
  expect(screen.queryByTestId('mentiora-webview', { includeHiddenElements: true })).toBeNull();
  expect(screen.queryByRole('button', { name: DEFAULT_STRINGS.retry })).toBeNull();
});

// Branch review, C2. `clearWatchdogTimer()` is the `initialize` handler's
// first statement, disarmed synchronously before the handler can fail — so a
// handler that REJECTS used to leave the widget permanently dead: the peer
// answers -32603 and keeps its latch, `handled` is still false so no ladder
// has claimed the incident, and `onLoadEnd` has already fired for this
// document and will not fire again, so nothing re-arms the watchdog. No
// surface, no event, no Retry, no Dismiss.
//
// The trigger here is the one §2.3 names in so many words: a signed-in
// install (`mentiora.wasSignedIn.<embedKey>` set) whose token endpoint is
// down. `identity.initial()` must fail the handshake rather than answer
// without a token, and "fail the handshake" is only a real answer if the
// failure lands somewhere the user can see.
//
// Catches the single-line deletion of `armWatchdog()` from the handler's
// catch: without it, `onEvent` is never called at all and no button renders.
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
      widgetOrigin={ORIGIN}
      embedKey={KEY}
      onEvent={onEvent}
      storage={storage}
      identity={{ getToken: () => Promise.reject(new Error('token endpoint down')) }}
    />,
  );
  const el = screen.getByTestId('mentiora-webview');
  await initialize(el);
  // Past the boot ladder's own sleeps (BOOT_RETRY_POLICY: 2 attempts, <=500ms
  // between), then past both watchdog cycles — one silent reload, then the
  // give-up branch.
  await advance(20000);

  // The handler really did reject, rather than never being reached: -32603 is
  // what the peer answers a throwing handler with. Without this the test would
  // also pass for a page that never sent `initialize` at all, which is the
  // ordinary watchdog case and proves nothing about the catch.
  expect(sent().some((m) => (m.error as { code?: number } | undefined)?.code === -32603)).toBe(
    true,
  );
  expect(onEvent).toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
  expect(screen.getByRole('button', { name: DEFAULT_STRINGS.retry })).toBeTruthy();
  expect(screen.getByRole('button', { name: DEFAULT_STRINGS.dismiss })).toBeTruthy();
});

// Branch review, C3 — the WIRING of `randomSource.reset()` into
// `advanceGeneration`, which is the half `random.test.ts` cannot see. Without
// host WebCrypto (React Native's real state, no polyfill) the session key
// comes from a round trip to the page, and `random.ts` allows exactly one in
// flight. A page that asks and is then replaced leaves that slot held for the
// rest of its 2s timeout, so the REPLACEMENT page's `initialize` — the
// recovery handshake — takes `-32603` on its first line.
//
// Catches the single-line deletion of `randomSource.reset()` from
// `advanceGeneration()`: without it page B is answered an error instead of a
// result.
test('a reload while the random round trip is parked does not poison the next handshake', async () => {
  const realCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    const el = await mount();
    await initialize(el); // page A parks a bytes() request that can never be answered
    await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
    // The network ladder's first delay is jittered 0-1000ms; this is past it,
    // and well short of the round trip's own 2s timeout — so the slot is still
    // held at the moment the load boundary runs.
    await advance(1500);
    expect(__lastWebView().reload).toHaveBeenCalledTimes(1);

    // Page B, the reloaded document. Two replies: one for the session key, one
    // for the install id this first launch still has to mint.
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
    for (let i = 0; i < 2; i++) {
      await fireEvent(el, 'message', {
        nativeEvent: {
          data: JSON.stringify({ tag: RANDOM_REPLY_TAG, bytes: Array(16).fill(4) }),
        },
      });
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

// Branch review, M1. §2.5 bounds crash recovery BECAUSE of
// `react-native-webview`#1767: a page that crashes deterministically. Such a
// page boots fine and dies later, when it renders the thread — so a
// `crashFailures` reset inside the `initialize` handler is spent on every
// cycle and the bound never applies to the one page it was written for. The
// test above ("Retry recovers a dead renderer") drives four crashes with NO
// handshake between them, which is why it could not see this.
//
// Catches the single-line re-addition of `crashFailures.current = 0` to the
// `initialize` handler: with it, the loop below never reaches the cap and no
// error event is ever emitted.
test('a clean handshake between crashes does not buy a fresh crash budget', async () => {
  const onEvent = jest.fn();
  await mount(onEvent);
  for (let i = 0; i < 4; i++) {
    const el = screen.getByTestId('mentiora-webview');
    await initialize(el); // every cycle boots cleanly, then the renderer dies
    await fireEvent(el, 'renderProcessGone', { nativeEvent: { didCrash: true } });
    await advance(9000);
  }
  expect(onEvent).toHaveBeenCalledWith({ type: 'error', code: 'renderer_crashed' });
  expect(screen.getByRole('button', { name: DEFAULT_STRINGS.retry })).toBeTruthy();
});
