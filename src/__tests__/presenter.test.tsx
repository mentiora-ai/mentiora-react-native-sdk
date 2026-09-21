// src/__tests__/presenter.test.tsx
//
// Task 12: `Mentiora.open()/close()/logout()` presenting `<MentioraWidget />`
// over a `Modal`. `react-native`'s `Modal` is NOT mocked (unlike WebView), so
// `onRequestClose` is read straight off the rendered element rather than
// fired as a DOM-style event.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StrictMode, useEffect } from 'react';
import {
  __lastWebView,
  __resetWebViews,
  type MockWebViewRef,
} from '../../__mocks__/react-native-webview';
import { MentioraWidget } from '../MentioraWidget';
import { __resetPresenter, Mentiora, MentioraHost } from '../presenter';
import { RANDOM_REPLY_TAG } from '../random';
import { __resetRuntimes, getRuntime } from '../runtime';
import { DEFAULT_STRINGS } from '../ui/strings';

const ORIGIN = 'https://w.x.ai';
const KEY = 'pk_wgt_a';
const cfg = { widgetOrigin: ORIGIN, embedKey: KEY };

beforeEach(() => {
  __resetRuntimes();
  __resetWebViews();
  __resetPresenter();
  Mentiora.close();
});

// Fake timers for the WHOLE file, not toggled per test: `driveCrashLadderToExhaustion`
// needs to advance past the widget's own mount-armed watchdog and recovery
// timers, and Jest's fake timers only intercept a `setTimeout` call made
// AFTER `jest.useFakeTimers()` runs — switching mid-test, after a widget has
// already mounted under real timers, leaves that specific timer unreachable
// by `advanceTimersByTimeAsync`. 11b's file makes the same file-wide choice
// for the same reason.
beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// -- helpers ------------------------------------------------------------
//
// `handshake`/`backHandling` copy 11c's shape; `handshakeInstallId` extends
// 11a's `sent()` pattern to pull `installId` out of the initialize reply;
// `driveCrashLadderToExhaustion` copies 11b's `advance()` pattern and its own
// "Retry recovers a dead renderer" test's loop shape.
const BRIDGE_INJECTION = /^window\.mentioraHost\.receive\((.*)\);true;$/s;

const sentFrom = (view: MockWebViewRef = __lastWebView()): Record<string, unknown>[] =>
  (view.injectJavaScript as jest.Mock).mock.calls.flatMap(([script]: [string]) => {
    const m = BRIDGE_INJECTION.exec(script);
    return m ? [JSON.parse(JSON.parse(m[1] as string) as string) as Record<string, unknown>] : [];
  });

const sent = (): Record<string, unknown>[] => sentFrom(__lastWebView());

const handshake = async (el: ReturnType<typeof screen.getByTestId>): Promise<void> => {
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

const handshakeInstallId = async (el: ReturnType<typeof screen.getByTestId>): Promise<string> => {
  await handshake(el);
  await waitFor(() => {
    expect(sent().length).toBeGreaterThanOrEqual(1);
  });
  const reply = sent().at(-1) as { result?: { installId?: string } };
  const id = reply.result?.installId;
  if (typeof id !== 'string') throw new Error('no installId in the handshake reply');
  return id;
};

// Every send once a session exists carries `params.sessionKey` (peer.ts's
// `withSessionParams`) — pull it off the last message sent so far, on
// whichever WebView is currently `__lastWebView()` unless told otherwise.
const currentSessionKey = (view?: MockWebViewRef): string => {
  const last = sentFrom(view).at(-1) as { params?: { sessionKey?: string } } | undefined;
  const key = last?.params?.sessionKey;
  if (typeof key !== 'string') throw new Error('no session key yet — call handshake() first');
  return key;
};

const backHandling = (active: boolean, view?: MockWebViewRef): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'mentiora/backHandling',
    params: { sessionKey: currentSessionKey(view), active },
  });

// `Modal` (unlike `react-native-webview`) is NOT mocked, and this project's
// RNTL has no `UNSAFE_getByType`: `Modal` renders straight down to the native
// `RCTModalHostView`, which carries `onRequestClose` as one of its own host
// props (`Modal.js`). Read it off that host node rather than firing a
// DOM-style event `fireEvent` has no mapping for.
const requestClose = (): void => {
  // `screen.container`, not `screen.root` (which is only `container.children[0]`
  // — the FIRST top-level sibling): several tests here render the Modal's
  // host alongside an inline `<MentioraWidget />` sibling, and `root` would
  // silently search only the sibling that happens to render first.
  const [modal] = screen.container.queryAll(
    (node) => typeof node.props.onRequestClose === 'function',
    { includeSelf: true },
  );
  if (!modal) throw new Error('no Modal with onRequestClose found — call Mentiora.open() first');
  (modal.props.onRequestClose as () => void)();
};

// Drives `CRASH_RETRY_POLICY.attempts` (4) `onRenderProcessGone` failures to
// exhaustion, the same way 11b's own "Retry recovers a dead renderer" test
// does — re-querying `mentiora-webview` by testID on every iteration rather
// than caching the element, because `onRenderProcessGone`'s recovery bumps
// `remountKey` and swaps the WebView instance out from under a cached
// reference on every attempt but the last.
const driveCrashLadderToExhaustion = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    await fireEvent(screen.getByTestId('mentiora-webview'), 'renderProcessGone', {
      nativeEvent: { didCrash: true },
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(9000);
    });
  }
};

// Fix round 3, Major 5: mimics an open-on-launch deep link / push-notification
// handoff — a screen that calls `Mentiora.open()` from its own mount effect,
// with no control over where `<MentioraHost />` sits relative to it in the
// tree.
function OpenOnMount({ onError }: { onError: (error: unknown) => void }): null {
  useEffect(() => {
    Mentiora.open().catch(onError);
  }, [onError]);
  return null;
}

// Fix round 3, Minor: two hosts with stable identity (`key`) across a
// rerender, so removing one specific host (not "whichever ends up at index
// 0") is actually reachable in a test — plain positional children would have
// React reuse index 0 regardless of which logical host that was.
function TwoHosts({ showFirst }: { showFirst: boolean }): React.JSX.Element {
  return (
    <>
      {showFirst && <MentioraHost key="a" />}
      <MentioraHost key="b" />
    </>
  );
}

test('open presents a Modal and close dismisses it', async () => {
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  expect(screen.queryByTestId('mentiora-webview')).toBeNull();
  await act(async () => {
    await Mentiora.open();
  });
  expect(screen.getByTestId('mentiora-webview')).toBeTruthy();
  await act(async () => {
    Mentiora.close();
  });
  expect(screen.queryByTestId('mentiora-webview')).toBeNull();
});

test('open works with no widget mounted anywhere — that is the whole point', async () => {
  // design.md:117-121 shows configure() + open() standing alone, and :414's example app
  // puts the button on a different screen from the embedded tab. (A <MentioraHost />
  // still has to be mounted somewhere — fix round 1 replaced the AppRegistry-wrapper
  // approach that made even that automatic — but no INLINE <MentioraWidget /> is needed.)
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  expect(screen.getByTestId('mentiora-webview')).toBeTruthy();
});

test('open before configure throws a clear error naming the missing call', async () => {
  await expect(Mentiora.open()).rejects.toThrow(/configure/);
});

test('open throws a distinct error naming MentioraHost when configured but no host is mounted', async () => {
  // A customer who configured but forgot to mount the host learns THAT, not
  // "call configure()" again — a customer who did neither gets the configure
  // message instead (checked above), since that's the more fundamental gap.
  Mentiora.configure(cfg);
  await expect(Mentiora.open()).rejects.toThrow(/MentioraHost/);
});

test('two mounted hosts never render two Modals — the oldest-mounted one owns it', async () => {
  // Only one is ever expected in practice (one `<MentioraHost />`, once, at
  // the app root) — this is the "briefly two during a screen transition"
  // case, and the rule is a total order (oldest-mounted wins) rather than
  // "last wins" or "undefined", so it never shows two Modals, even for one
  // frame.
  Mentiora.configure(cfg);
  await render(
    <>
      <MentioraHost />
      <MentioraHost />
    </>,
  );
  await act(async () => {
    await Mentiora.open();
  });
  expect(screen.getAllByTestId('mentiora-webview')).toHaveLength(1);
});

test('after the active host unmounts, a surviving host takes over the Modal', async () => {
  // Fix round 3, Minor (mutation-verified — see the report): `activeHostId`
  // must be re-assigned to a SURVIVING host on the active one's unmount, not
  // dropped to `null` — the latter fails silently (`open()` still succeeds,
  // since a host IS still mounted, but nothing ever renders).
  Mentiora.configure(cfg);
  const view = await render(<TwoHosts showFirst={true} />);
  await act(async () => {
    await Mentiora.open();
  });
  expect(screen.getAllByTestId('mentiora-webview')).toHaveLength(1);
  await view.rerender(<TwoHosts showFirst={false} />); // unmounts ONLY host "a", the active one
  await waitFor(() => {
    expect(screen.getAllByTestId('mentiora-webview')).toHaveLength(1);
  });
});

test('open() succeeds when the host mounts after its caller, in the same commit', async () => {
  // Fix round 3, Major 5: `useSyncExternalStore` subscribes in a passive
  // effect, which runs in tree order — a host rendered AFTER the screen that
  // calls `open()` from ITS OWN mount effect has not subscribed yet when
  // that effect runs. `open()`'s host check counts from RENDER now, not
  // subscribe, so this must succeed regardless of sibling order.
  Mentiora.configure(cfg);
  const errors: unknown[] = [];
  await render(
    <>
      <OpenOnMount onError={(e) => errors.push(e)} />
      <MentioraHost />
    </>,
  );
  await waitFor(() => {
    expect(screen.getByTestId('mentiora-webview')).toBeTruthy();
  });
  expect(errors).toEqual([]);
});

test('open() succeeds with the host under StrictMode (the RN/Expo template default)', async () => {
  // Fix round 4, Critical 2. StrictMode mounts effects, tears them down and
  // mounts them again on the SAME fiber, without re-rendering. Counting
  // `hostIds` membership at render only (fix round 3's answer to Major 5,
  // above) meant the push ran once and the subscribe cleanup's splice ran
  // twice, so the host was deregistered permanently and `open()` threw
  // "needs <MentioraHost /> mounted" at an app whose host IS mounted — in
  // every new RN/Expo app, since their templates wrap the root in StrictMode.
  // The other order (the host-before-caller sibling case that used to live
  // here) is covered by the test above: it catches nothing this pair doesn't.
  Mentiora.configure(cfg);
  await render(
    <StrictMode>
      <MentioraHost />
    </StrictMode>,
  );
  await act(async () => {
    await expect(Mentiora.open()).resolves.toBeUndefined();
  });
  expect(screen.getByTestId('mentiora-webview')).toBeTruthy();
});

test('close before configure is a no-op, not a throw', () => {
  // Deliberately asymmetric with `logout()` (below), which now throws in the
  // equivalent case: there is nothing to undo here, so a mutation that made
  // this throw too — "unifying" the two guards — would be wrong, not merely
  // redundant. This guards specifically against that unification.
  expect(() => {
    Mentiora.close();
  }).not.toThrow();
});

test('reopening remounts the WebView — the reload is intended, not a bug', async () => {
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  const first = __lastWebView();
  await act(async () => {
    Mentiora.close();
  });
  await act(async () => {
    await Mentiora.open();
  });
  expect(__lastWebView()).not.toBe(first);
  expect(first.reload).not.toHaveBeenCalled(); // a remount, not a reload of the old one
});

test('logout before configure throws, naming the missing call', async () => {
  // Fix round 3, Major 6: silently resolving here would strand the PREVIOUS
  // user's install id and `wasSignedIn` flag in storage, undiagnosable.
  await expect(Mentiora.logout()).rejects.toThrow(/configure/);
});

test('logout with the Modal closed and no inline widget still rotates the install id', async () => {
  // Rewritten (fix round 3): the original version only asserted the promise
  // resolved, which is also true of a `logout()` that does nothing at all —
  // asserting the actual, real-runtime side effect is what makes this
  // non-vacuous.
  Mentiora.configure(cfg);
  const bytesOf =
    (fill: number) =>
    async (n: number): Promise<Uint8Array> =>
      new Uint8Array(n).fill(fill);
  const before = await getRuntime(cfg).installId(bytesOf(1));
  await Mentiora.logout();
  const after = await getRuntime(cfg).installId(bytesOf(2));
  expect(after).not.toBe(before);
});

test('after a closed-state logout the next open initializes with the rotated install id', async () => {
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  const before = await handshakeInstallId(screen.getByTestId('mentiora-webview'));
  await act(async () => {
    Mentiora.close();
  });
  await act(async () => {
    await Mentiora.logout();
  });
  await act(async () => {
    await Mentiora.open();
  });
  const after = await handshakeInstallId(screen.getByTestId('mentiora-webview'));
  expect(after).not.toBe(before);
});

test('logout reloads an inline widget onto a page that can handshake, under a new session key', async () => {
  // Fix round 3, Major 8: design.md §2.4's "logout() ... reloads whichever
  // widgets are mounted" applies to an INLINE widget too, not only the one
  // inside the Modal — `MentioraWidget` subscribes to `runtime.onReload`
  // itself. The original test here registered its OWN listener on the runtime
  // and could not have caught a widget that never subscribed at all.
  //
  // Fix round 4, Critical 1: the version after that one asserted only that the
  // WebView INSTANCE changed, which is the mechanism, not the outcome — and
  // that gap is exactly how a remount with no load boundary shipped. Without
  // `beginFreshLoad()` (so without `peer.resetLoad()`) the remounted page is
  // dead: its `initialize` is answered `-32600 "initialize already completed
  // for this page load"`, that rejection is STAMPED with the pre-logout
  // session key, and the peer goes on authorizing that key for the next
  // user's page. Assert the outcome instead: the fresh page completes a
  // handshake, and nothing sent to it carries the previous session's key.
  Mentiora.configure(cfg);
  await render(<MentioraWidget {...cfg} />);
  const before = __lastWebView();
  await handshake(screen.getByTestId('mentiora-webview'));
  const keyBefore = currentSessionKey(before);

  await act(async () => {
    await Mentiora.logout();
  });

  const after = __lastWebView();
  expect(after).not.toBe(before); // remounted, not reloaded in place
  // Throws ("no installId in the handshake reply") if the page got `-32600`
  // instead of a result — i.e. if the remount skipped the load boundary.
  expect(await handshakeInstallId(screen.getByTestId('mentiora-webview'))).toEqual(
    expect.any(String),
  );
  expect(
    sentFrom(after).map((message) => (message.params as { sessionKey?: string })?.sessionKey),
  ).not.toContain(keyBefore);
});

test('logout clears a stale error surface instead of leaving it over the fresh page', async () => {
  // Fix round 5: the reload handler did `beginFreshLoad()` + `setRemountKey`
  // and stopped there, while Retry — the same event, a user-initiated fresh
  // start — also cleared `errorCode` and every ladder counter. So logging out
  // from the error screen left "something went wrong" covering a healthy,
  // freshly rotated page, with Retry as the only apparent way forward on a
  // page that was already fine. Both paths now run the SAME `restartLoad`.
  Mentiora.configure(cfg);
  await render(<MentioraWidget {...cfg} />);
  await driveCrashLadderToExhaustion();
  expect(screen.getByRole('button', { name: DEFAULT_STRINGS.retry })).toBeTruthy();

  await act(async () => {
    await Mentiora.logout();
  });

  expect(screen.queryByRole('button', { name: DEFAULT_STRINGS.retry })).toBeNull();
  // Not just "the surface is gone": the page under it is a real, working one.
  expect(await handshakeInstallId(screen.getByTestId('mentiora-webview'))).toEqual(
    expect.any(String),
  );
});

test('an inline widget unsubscribes from runtime.onReload on unmount', async () => {
  Mentiora.configure(cfg);
  const rt = getRuntime(cfg);
  const realOnReload = rt.onReload;
  let off: jest.Mock | undefined;
  rt.onReload = (fn: () => void): (() => void) => {
    const unsubscribe = realOnReload(fn);
    off = jest.fn(unsubscribe);
    return off;
  };
  const view = await render(<MentioraWidget {...cfg} />);
  await view.unmount();
  expect(off).toHaveBeenCalled();
});

test('onRequestClose forwards mentiora/back to the page while it holds the button, and stays open', async () => {
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  const el = screen.getByTestId('mentiora-webview');
  await handshake(el);
  await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
  await act(async () => {
    requestClose();
  });
  expect(sent().at(-1)).toMatchObject({ method: 'mentiora/back' });
  expect(screen.getByTestId('mentiora-webview')).toBeTruthy(); // still open
});

test('onRequestClose dismisses only once the page released the back button', async () => {
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  const el = screen.getByTestId('mentiora-webview');
  await handshake(el);
  await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
  await act(async () => {
    requestClose();
  });
  expect(screen.queryByTestId('mentiora-webview')).toBeTruthy(); // still open
  await fireEvent(el, 'message', { nativeEvent: { data: backHandling(false) } });
  await act(async () => {
    requestClose();
  });
  expect(screen.queryByTestId('mentiora-webview')).toBeNull(); // now it dismisses
});

test('onRequestClose dismisses even while the page holds back, once the error surface is up', async () => {
  // Establish a session first, so the page can actually claim the button
  // (a handler only exists once `onHardwareBack` has something live to
  // check), then drive the CRASH ladder — the WebView stays mounted under
  // the error surface (`importantForAccessibility`, never an unmount), so
  // the registration from before the crash is still the one `onRequestClose`
  // reads under the error surface.
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  await handshake(screen.getByTestId('mentiora-webview'));
  await fireEvent(screen.getByTestId('mentiora-webview'), 'message', {
    nativeEvent: { data: backHandling(true) },
  });
  await driveCrashLadderToExhaustion();
  const view = __lastWebView();
  const sentBeforeClose = sentFrom(view).length;
  await act(async () => {
    requestClose();
  });
  // `includeHiddenElements` matters here specifically: the WebView is marked
  // `importantForAccessibility="no-hide-descendants"` under the error
  // surface, which RNTL's queries exclude BY DEFAULT — a plain
  // `queryByTestId` would read as `null` (looks dismissed) even while still
  // mounted, hiding exactly the bug this test exists to catch.
  expect(screen.queryByTestId('mentiora-webview', { includeHiddenElements: true })).toBeNull();
  expect(
    sentFrom(view)
      .slice(sentBeforeClose)
      .some((message) => message.method === 'mentiora/back'),
  ).toBe(false);
});

test('a transient reload does not leave the Modal back button dead (Critical 1)', async () => {
  // `onHardwareBack` re-checks `peer.sessionKey() !== null` at PRESS TIME,
  // not a stale flag — a single transient load failure resets the session
  // key (`advanceGeneration` -> `peer.resetLoad()`) WITHOUT ever showing the
  // error surface (`LOAD_RETRY_POLICY.attempts` = 3, so one failure just
  // schedules a reload). Before fix round 3, `onRequestClose` asked "is
  // there an entry in the map?" and got a stale yes, calling a `sendBack()`
  // that silently no-ops once the session is gone and never dismissing.
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  const el = screen.getByTestId('mentiora-webview');
  await handshake(el);
  await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
  await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(2000); // past the ~1s first retry delay
  });
  // Captured before `requestClose()`: dismissing unmounts the WebView, and
  // `sent()`/`__lastWebView()` throw once none is mounted — this ref object
  // itself, and its call history, are still good afterward.
  const view = __lastWebView();
  const sentBeforeClose = sentFrom(view).length;
  await act(async () => {
    requestClose();
  });
  expect(screen.queryByTestId('mentiora-webview')).toBeNull(); // dismissed, not left inert
  expect(
    sentFrom(view)
      .slice(sentBeforeClose)
      .some((message) => message.method === 'mentiora/back'),
  ).toBe(false);
});

test('an inline widget on the same embed key does not hijack the Modal back channel (Critical 2)', async () => {
  // design.md §3.1's own example app: a header button opening the Modal and
  // a tab embedding <MentioraWidget /> directly, both on the SAME embed key.
  // Before fix round 3, the back channel was keyed by embedKey, so whichever
  // widget last claimed the button under that key answered for BOTH.
  Mentiora.configure(cfg);
  await render(
    <>
      <MentioraWidget {...cfg} />
      <MentioraHost />
    </>,
  );
  const inlineView = __lastWebView(); // only one mounted so far (the host isn't open yet)
  const inlineEl = screen.getByTestId('mentiora-webview');
  await handshake(inlineEl);
  await fireEvent(inlineEl, 'message', {
    nativeEvent: { data: backHandling(true, inlineView) },
  });
  const inlineSentBefore = sentFrom(inlineView).length;

  await act(async () => {
    await Mentiora.open();
  });
  // The Modal's own page never claims back — it's fresh, at its root.
  await act(async () => {
    requestClose();
  });

  // Fixed: keyed per WIDGET INSTANCE (a context), never by embedKey, so the
  // inline widget's registration is never even consulted here — the Modal
  // dismisses on its own widget's (unclaimed) back state, and the inline
  // widget's page is never sent anything.
  expect(screen.getAllByTestId('mentiora-webview')).toHaveLength(1); // only the inline one left
  expect(
    sentFrom(inlineView)
      .slice(inlineSentBefore)
      .some((message) => message.method === 'mentiora/back'),
  ).toBe(false);
});

test('after Retry recovers from an error, the Modal honours a fresh back hold again (Major 4)', async () => {
  // Fix round 3, Major 4: a `blocked`-style one-way latch never cleared when
  // Retry clears `errorCode` would leave EVERY future back press dismissing
  // the Modal for the rest of its life, even after a fresh, healthy session.
  // `onHardwareBack`'s OWN `errorCode !== null` check is read live, so it
  // re-enables itself the moment Retry clears the surface — there is no
  // separate latch left to go stale.
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  await driveCrashLadderToExhaustion(); // error surface up
  await act(async () => {
    await fireEvent.press(screen.getByRole('button', { name: DEFAULT_STRINGS.retry }));
  });
  const el = screen.getByTestId('mentiora-webview');
  await handshake(el);
  await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
  await act(async () => {
    requestClose();
  });
  expect(sent().at(-1)).toMatchObject({ method: 'mentiora/back' });
  expect(screen.getByTestId('mentiora-webview')).toBeTruthy(); // still open
});

test('a host onEvent that throws on close still lets the presenter close the Modal (Major 7)', async () => {
  // Fix round 3, Major 7: the wrapper used to call the host's `onEvent`
  // BEFORE its own bookkeeping. `MentioraWidget`'s Dismiss path
  // (`onDismiss`) wraps ITS OWN `onEvent` call in try/catch — "the one call
  // that must not be able to take the exit down with it" — which then also
  // swallowed the presenter's `Mentiora.close()` as collateral when it ran
  // AFTER the (throwing) host callback, stranding a `visible={true}` Modal
  // over the blank `<View />` Dismiss had just rendered, with no escape on
  // iOS (`onRequestClose` never fires there).
  const throwingConfig = {
    ...cfg,
    onEvent: (event: { type: string }): void => {
      // Only `close` throws — `error` (fired first, driving the ladder to
      // exhaustion below) must not, or the throw would happen there instead
      // of at the point this test actually means to exercise.
      if (event.type === 'close') throw new Error('boom');
    },
  };
  Mentiora.configure(throwingConfig);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  await driveCrashLadderToExhaustion(); // error surface with a Dismiss button
  await act(async () => {
    await fireEvent.press(screen.getByRole('button', { name: DEFAULT_STRINGS.dismiss }));
  });
  expect(screen.queryByTestId('mentiora-webview', { includeHiddenElements: true })).toBeNull();
});
