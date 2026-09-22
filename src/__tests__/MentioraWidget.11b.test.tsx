// The recovery coordinator: the network retry ladder (`onError`), the crash ladder
// (`onContentProcessDidTerminate` / `onRenderProcessGone`), the handshake watchdog,
// and the generation-scoped ownership rule that keeps one incident from driving two
// of them.
//
// Modern fake timers, and `jest.advanceTimersByTimeAsync` only: the synchronous
// `advanceTimersByTime` does not drain the microtask queue the `await`s inside the
// coordinator and inside `peer.receive` sit on, so a timer's callback fires but its
// own awaits never resolve in the same tick.
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StrictMode, Suspense } from 'react';
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

// `jest.advanceTimersByTimeAsync` fires timer callbacks outside React's `act()`
// scope, and the crash path calls `setState` (a remount-key bump) from inside one.
// RNTL's `render`/`fireEvent` wrap themselves in `act`; a bare timer advance does
// not, so React warns. Wrapping here silences that without changing which timer API
// is used.
const advance = (ms: number) => act(async () => jest.advanceTimersByTimeAsync(ms));

// Everything this component injected that is a bridge message, parsed back out.
const sent = (): Record<string, unknown>[] =>
  (__lastWebView().injectJavaScript as jest.Mock).mock.calls.flatMap(([script]: [string]) => {
    const m = /window\.mentioraHost\.receive\((.*)\);\s*true;\s*$/s.exec(script);
    return m ? [JSON.parse(JSON.parse(m[1] as string) as string) as Record<string, unknown>] : [];
  });

// The scripts that are random-bytes requests, newest last, plus the per-request
// nonce each carries: a reply that does not echo it is not ours and the router
// declines it.
const randomScripts = (): string[] =>
  (__lastWebView().injectJavaScript as jest.Mock).mock.calls
    .map(([script]: [string]) => script)
    .filter((script: string) => script.includes(RANDOM_REPLY_TAG));

const answerLastRandom = (el: ReturnType<typeof screen.getByTestId>, fill: number) => {
  const script = randomScripts().at(-1);
  if (script === undefined) throw new Error('no random request outstanding');
  const m = /,k="([^"]+)"/.exec(script);
  if (!m) throw new Error('the injected random script carries no nonce');
  return fireEvent(el, 'message', {
    nativeEvent: {
      data: JSON.stringify({ tag: RANDOM_REPLY_TAG, nonce: m[1], bytes: Array(16).fill(fill) }),
    },
  });
};

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
  // The negative alone ("never load_failed") also passes for an implementation
  // that emits no events at all. The positive pins that the watchdog fired and gave
  // up — two 8s cycles fit inside 20s.
  expect(codes).toContain('handshake_timeout');
  expect(codes).not.toContain('load_failed');
});

// A rejected handshake's watchdog is the re-armed one, and it is late. This test
// owns that timing and nothing else.
//
// It does not cover the synchronous `clearWatchdogTimer()`: host WebCrypto is
// disabled here, so `bytes()` parks and rejects at 2s and the catch calls
// `armWatchdog()`, which clears the mount-armed timer as a side effect. Delete the
// synchronous clear and this still passes. The sibling test below, on a handshake
// that succeeds, is where the clear is guarded; the two cannot share one test,
// because one needs a rejecting handshake and the other a successful one.
test('a rejected handshake is reloaded by the RE-ARMED watchdog, not the mount-armed one', async () => {
  // Told apart by when they fire: the mount-armed watchdog at 8s, the re-armed one
  // at 2s (the round trip's own timeout) + 8s. Not before 9s, done by 11s.
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

// The only test that covers the synchronous `clearWatchdogTimer()`. On a rejecting
// handshake the catch's `armWatchdog()` clears the mount-armed timer as a side
// effect, so that path looks identical with and without the clear; only a handshake
// that succeeds separates them, because nothing else clears the watchdog there.
//
// Under Jest `globalThis.crypto` exists, so the composition root passes it as
// `globalCrypto` and `bytes()` resolves in a microtask: no round trip to park, no
// rejection, nothing but the clear between a good handshake and the 8s timer. Fails
// if `clearWatchdogTimer()` is not the `initialize` handler's first statement — the
// page is then answered and reloaded 100ms later, its brand-new session key
// discarded.
test('a handshake that succeeds at 7.9s is answered and NOT reloaded at 8s', async () => {
  const onEvent = jest.fn();
  const el = await mount(onEvent);
  await advance(7900); // the mount-armed watchdog has 100ms left
  await initialize(el);
  await advance(300); // past 8000

  // The handshake really landed. Without this the test also passes for a page whose
  // `initialize` was rejected or never parsed, which is the ordinary watchdog case.
  expect(sent().some((m) => 'result' in m)).toBe(true);
  expect(__lastWebView().reload).not.toHaveBeenCalled();
  expect(onEvent).not.toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
});

test('a network-ladder reload that never re-initializes still gets caught by the watchdog', async () => {
  // A transient blip triggers the network ladder, its reload succeeds at the HTTP
  // level, but the page's JS never calls `initialize` again. Without a watchdog
  // re-armed for the new generation nothing ever fires: no error surface, no
  // `onEvent`, and no Dismiss either, since the page draws its own chrome.
  // `onLoadEnd` is what re-arms it, once that reload's document finishes loading —
  // never the ladder's own `reload()`/remount call, which on Android runs no
  // navigation callback at all.
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
  // unmount, so `__lastWebView()` would throw afterwards, but this `jest.fn()`
  // reference still shows whether the old instance was asked to reload.
  const { reload } = __lastWebView();
  await view.unmount();
  // Without the cleanup effect the mount-armed watchdog keeps ticking:
  // `beginFreshLoad()` at 8s is harmless (`webview.current` is null post-unmount, so
  // its `reload()` is a no-op), but the second watchdog it re-arms fires at 16s and
  // calls `showError`, which calls the host's `onEvent` regardless of mount state —
  // `latest.current` is a plain ref, not tied to the React tree.
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
  // The instance whose renderer Android already killed. Android's docs say a dead
  // instance must be removed from the hierarchy and destroyed, never reused, so the
  // repair is a fresh instance, not a `.reload()` on this one.
  const deadWebView = __lastWebView();
  await fireEvent.press(screen.getByRole('button', { name: DEFAULT_STRINGS.retry }));
  expect(__webViews()).toHaveLength(1); // the dead one unregistered, exactly one replaced it
  expect(__webViews()[0]).not.toBe(deadWebView);
  expect(deadWebView.reload).not.toHaveBeenCalled();
});

test('the error overlay is modal to a screen reader — both flags flip with errorCode', async () => {
  // This RNTL version has no `getByProps`-style query. `queryAll` with a predicate
  // is the escape hatch `test-renderer` offers, used because neither flag has any
  // other query surface — no text, no role, no testID.
  const modalOverlays = () =>
    screen.container.queryAll((i) => i.props.accessibilityViewIsModal === true);

  const el = await mount();
  expect(el.props.importantForAccessibility).toBe('auto');
  expect(modalOverlays()).toHaveLength(0);
  for (let i = 0; i < 3; i++) {
    await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
    await advance(9000);
  }
  // A screen reader must not reach the dead page behind the exit screen: Android
  // hides the WebView subtree from TalkBack, iOS marks the overlay modal for
  // VoiceOver. Read off `el`, not `getByTestId` — RNTL's default queries treat an
  // element carrying `importantForAccessibility="no-hide-descendants"` as hidden,
  // and that is the prop under test. `el` is the same instance throughout, since the
  // network ladder only calls `.reload()` and never remounts.
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
  // Only the first terminal callback for a generation picks a path, so the crash
  // counter above still reads 0 and needs its full cap — 3 more recoveries, 4 total
  // — before any surface appears. Without the `handled` gate both callbacks run,
  // that first incident is double-counted, and the counter is already at its cap of
  // 4 after these same 3 genuine crash-only incidents. Hence 3, not fewer.
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
  // `includeHiddenElements` because a Dismiss that failed to unmount leaves the
  // WebView `importantForAccessibility="no-hide-descendants"` beneath the overlay,
  // which RNTL's queries exclude by default: a plain `queryByTestId` reads `null`
  // and passes without proving anything.
  expect(screen.queryByTestId('mentiora-webview', { includeHiddenElements: true })).toBeNull();
  expect(screen.queryByRole('button', { name: DEFAULT_STRINGS.retry })).toBeNull();
});

// `clearWatchdogTimer()` is the `initialize` handler's first statement, disarmed
// synchronously before the handler can fail, so the handler's catch has to re-arm.
// Without `armWatchdog()` there, a rejecting handler leaves the widget permanently
// dead: the peer answers -32603 and keeps its latch, `handled` is still false so no
// ladder has claimed the incident, and `onLoadEnd` has already fired for this
// document and will not fire again. No surface, no event, no Retry, no Dismiss.
//
// The trigger is a signed-in install (`mentiora.wasSignedIn.<embedKey>` set) whose
// token endpoint is down. `identity.initial()` must fail the handshake rather than
// answer without a token, and that failure has to land where the user can see it.
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
  // Past the boot ladder's sleeps (BOOT_RETRY_POLICY: 2 attempts, <=500ms between),
  // then past both watchdog cycles: one silent reload, then the give-up branch.
  await advance(20000);

  // The handler really did reject rather than never being reached: -32603 is what
  // the peer answers a throwing handler with. Without this the test also passes for
  // a page that never sent `initialize`, which is the ordinary watchdog case.
  expect(sent().some((m) => (m.error as { code?: number } | undefined)?.code === -32603)).toBe(
    true,
  );
  expect(onEvent).toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
  expect(screen.getByRole('button', { name: DEFAULT_STRINGS.retry })).toBeTruthy();
  expect(screen.getByRole('button', { name: DEFAULT_STRINGS.dismiss })).toBeTruthy();
});

// The wiring of `randomSource.reset()` into `advanceGeneration()`, which
// `random.test.ts` cannot see. Without host WebCrypto — React Native's real state,
// no polyfill — the session key comes from a round trip to the page, and `random.ts`
// allows exactly one in flight. A page that asks and is then replaced holds that
// slot for the rest of its 2s timeout, so without the reset the replacement page's
// `initialize` takes `-32603` on its first line.
test('a reload while the random round trip is parked does not poison the next handshake', async () => {
  const realCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    const el = await mount();
    await initialize(el); // page A parks a bytes() request that can never be answered
    await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
    // Past the network ladder's first delay (jittered 0-1000ms) and well short of
    // the round trip's 2s timeout, so the slot is still held when the load boundary
    // runs.
    await advance(1500);
    expect(__lastWebView().reload).toHaveBeenCalledTimes(1);

    // Page B, the reloaded document. Page A's parked request is still in the mock's
    // call log, so count from where page B starts rather than from zero.
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
    // Two round trips: the session key, then the install id this first launch
    // still has to mint. Each answer must carry its OWN request's nonce, so the
    // second one waits for that request to actually go out.
    for (let i = 0; i < 2; i++) {
      await act(async () => {});
      expect(randomScripts()).toHaveLength(beforeB + i + 1);
      await answerLastRandom(el, 4);
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

// Crash recovery is bounded because of `react-native-webview`#1767: a page that
// crashes deterministically boots fine and dies later, when it renders the thread.
// A `crashFailures` reset inside the `initialize` handler is therefore spent on
// every cycle and the bound never applies to the page it was written for. The test
// above drives four crashes with no handshake between them, so it cannot see this.
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

/** A sibling that suspends on its first render and resolves after `release()`, so
 *  the boundary's children render once, are thrown away, and then mount for real. */
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

// `armWatchdog()` belongs in the `[]` effect. In the render body a ref guard stops
// re-renders but not renders that never commit, and the discarded render's closure
// holds the real host's `onEvent` (same props object), so ~16s later the host is
// told a healthy widget timed out.
test('a render that never commits leaves no watchdog behind', async () => {
  const onEvent = jest.fn();
  const { Suspends, release } = suspendOnce();
  await render(
    <Suspense fallback={null}>
      <MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} onEvent={onEvent} />
      <Suspends />
    </Suspense>,
  );
  await act(async () => {
    release();
  });

  // The real widget committed and handshook immediately, so nothing legitimate
  // can time out here.
  await initialize(screen.getByTestId('mentiora-webview'));
  await advance(20000);
  expect(onEvent).not.toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
});

// The other half. StrictMode mounts effects, tears them down and mounts them again.
// A render-armed timer is cleared by that simulated unmount and the ref guard stops
// anything re-arming, which kills the 8s floor in the RN/Expo template's default dev
// setup: a document that never finishes loading and never errors shows a blank
// widget with no error surface for as long as the platform's own request timeout.
test("the 8s floor survives StrictMode's simulated unmount", async () => {
  const onEvent = jest.fn();
  await render(
    <StrictMode>
      <MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} onEvent={onEvent} />
    </StrictMode>,
  );
  await advance(20000);
  expect(onEvent).toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
});

/** The widget under a switch, so unmounting it is an ordinary re-render of a
 *  surviving tree rather than tearing the test's own root down. */
function Mounted({
  show,
  onEvent,
}: {
  show: boolean;
  onEvent: jest.Mock;
}): React.JSX.Element | null {
  return show ? <MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} onEvent={onEvent} /> : null;
}

// The unmount cleanup bumps `generation.current`. Clearing only the timers that
// exist at that moment lets an `initialize` still parked on the random-bytes round
// trip — or on identity, or an install-id mint — reject afterwards, pass its own
// generation check, re-arm the watchdog on a dead instance, and ~18s later hand the
// host `{type:'error', code:'handshake_timeout'}` for a chat the user had closed.
test('an initialize rejecting after unmount never reaches the host', async () => {
  const realCrypto = globalThis.crypto;
  // No host WebCrypto: the session key needs a round trip to the page, which
  // nothing here will ever answer, so the handler parks and then rejects.
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    const onEvent = jest.fn();
    const view = await render(
      <Mounted show={true} onEvent={onEvent} />, // a screen the user can navigate away from
    );
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

// `peer.ts` answers every handler rejection `-32603 Internal error`, which is the
// protocol's wording and not ours to change. An install marked `wasSignedIn` booting
// with no `identity` configured therefore shows a blank widget for ~16s and then a
// Retry screen that can never succeed, so the `__DEV__` warn in the initialize
// handler's catch is the only thing naming the cause and the fix,
// `Mentiora.logout()`.
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
    const view = await render(
      <MentioraWidget widgetOrigin={ORIGIN} embedKey={KEY} storage={storage} />,
    );
    await initialize(view.getByTestId('mentiora-webview'));
    await advance(0);

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/mentiora identity:.*logout\(\)/s));
  } finally {
    warn.mockRestore();
  }
});
