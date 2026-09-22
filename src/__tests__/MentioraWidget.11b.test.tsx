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

// The scripts that are random-bytes REQUESTS, newest last, plus the per-request
// nonce each one carries (random.ts, external review B1): a reply that does not
// echo it is not ours and the router declines it.
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
  // The negative alone ("never load_failed") is the "both paths sent
  // nothing" shape — an implementation that emits no events at all would
  // pass it too. Assert the positive as well: the watchdog itself DID fire
  // and give up (two 8s cycles fit inside 20s), so its own code is present.
  expect(codes).toContain('handshake_timeout');
  expect(codes).not.toContain('load_failed');
});

// A rejected handshake's watchdog is the RE-ARMED one, and it is late
// (branch review, C2). This test owns that timing and nothing else.
//
// It does NOT cover the synchronous `clearWatchdogTimer()`, and its previous
// title said it did — re-review N2, this project's signature defect, caught
// for the sixth time. Host WebCrypto is disabled here, so `bytes()` parks and
// rejects at 2s; C2's catch then calls `armWatchdog()`, which clears the
// mount-armed timer as a SIDE EFFECT. Delete the synchronous clear and this
// test still passes, because the re-arm does its job for it. The sibling test
// below, on a handshake that SUCCEEDS, is where the clear is actually
// guarded — the two cannot live in one test, because one needs a rejecting
// handshake and the other needs a successful one.
test('a rejected handshake is reloaded by the RE-ARMED watchdog, not the mount-armed one', async () => {
  // Told apart by WHEN: the mount-armed watchdog fires at 8s, the re-armed one
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

// Re-review, N2. The test above can no longer catch a missing
// `clearWatchdogTimer()` and this one is why it is still covered. It disables
// host WebCrypto, so its handshake REJECTS — and C2's catch calls
// `armWatchdog()`, which clears the mount-armed timer as a side effect and
// re-arms later. The rejection path therefore looks identical with and
// without the synchronous clear. Only a handshake that SUCCEEDS separates
// them: nothing else clears the watchdog on that path.
//
// 7.9s is the case the handler's own comment names. Under Jest,
// `globalThis.crypto` exists, so the composition root passes it as
// `globalCrypto` and `bytes()` resolves in a microtask — no round trip to
// park, no rejection, nothing but the clear standing between a good handshake
// and the 8s timer.
//
// Catches deleting `clearWatchdogTimer()` from the `initialize` handler:
// without it the page is answered AND reloaded 100ms later, its brand-new
// session key discarded.
test('a handshake that succeeds at 7.9s is answered and NOT reloaded at 8s', async () => {
  const onEvent = jest.fn();
  const el = await mount(onEvent);
  await advance(7900); // the mount-armed watchdog has 100ms left
  await initialize(el);
  await advance(300); // past 8000

  // The handshake really landed — without this the test would also pass for a
  // page whose `initialize` was rejected or never parsed, which is the
  // ordinary watchdog case and proves nothing about the clear.
  expect(sent().some((m) => 'result' in m)).toBe(true);
  expect(__lastWebView().reload).not.toHaveBeenCalled();
  expect(onEvent).not.toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
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
    // for the install id this first launch still has to mint. Page A's own
    // parked request is still in the mock's call log, so count from where page
    // B starts rather than from zero.
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

// --- Re-review, F7 / F8: renders that never commit, and awaits that outlive
// the component ---

/** A sibling that suspends on its FIRST render and resolves after `release()`,
 *  so the boundary's children render once, are thrown away, and then mount for
 *  real. The discarded pass is the one that used to arm a timer. */
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

// `armWatchdog()` used to run in the RENDER BODY, ref-guarded against
// re-renders but not against renders that never commit. The discarded render's
// closure holds the REAL host's `onEvent` (same props object), so ~16s later
// the host is told a healthy widget timed out.
//
// Catches moving `armWatchdog()` back out of the `[]` effect into the render
// body.
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

// Re-review, F7 (the other half). StrictMode mounts effects, tears them down
// and mounts them again. The render-armed timer was cleared by that simulated
// unmount and the ref guard stopped anything from re-arming, so the 8s floor
// was dead in the RN/Expo template's default dev setup: a document that never
// finishes loading and never errors showed a blank widget with no error
// surface for as long as the platform's own request timeout.
//
// Catches deleting `armWatchdog()` from the `[]` effect.
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

// The unmount cleanup cleared the timers that existed AT THAT MOMENT but left
// `generation.current` alone, so an `initialize` still parked on the
// random-bytes round trip (or on identity, or on an install-id mint) rejected
// afterwards, passed its own generation check, re-armed the watchdog on a dead
// instance, and ~18s later handed the host `{type:'error',
// code:'handshake_timeout'}` for a chat the user had already closed.
//
// Catches deleting `generation.current += 1` from the `[]` effect's cleanup.
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

// --- Re-review, F12 ---
//
// `peer.ts` answers every handler rejection `-32603 Internal error` (the
// protocol's, not ours to change), so an install marked `wasSignedIn` booting
// with no `identity` configured showed a blank widget for ~16s and then a Retry
// screen that can never succeed — with nothing anywhere naming the cause or the
// fix, which is to call `Mentiora.logout()`.
//
// Catches deleting the `__DEV__` warn from the initialize handler's catch.
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
