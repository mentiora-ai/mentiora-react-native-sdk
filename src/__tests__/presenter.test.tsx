// `Mentiora.open()/close()/logout()` presenting `<MentioraWidget />` over a `Modal`.
// `react-native`'s `Modal` is not mocked, unlike WebView, so `onRequestClose` is read
// off the rendered element rather than fired as a DOM-style event.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StrictMode, Suspense, useEffect } from 'react';
import {
  __lastWebView,
  __resetWebViews,
  type MockWebViewRef,
} from '../../__mocks__/react-native-webview';
import { MentioraWidget } from '../MentioraWidget';
import { __resetPresenter, Mentiora, MentioraHost } from '../presenter';
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

// Fake timers for the whole file, not toggled per test. Jest's fake timers only
// intercept a `setTimeout` made after `jest.useFakeTimers()` runs, so switching
// mid-test — after a widget has mounted under real timers — leaves that widget's
// watchdog and recovery timers unreachable by `advanceTimersByTimeAsync`.
beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// -- helpers ------------------------------------------------------------
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
// `withSessionParams`), read off the last message sent on whichever WebView is
// currently `__lastWebView()` unless told otherwise.
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

// `Modal` is not mocked and this project's RNTL has no `UNSAFE_getByType`. `Modal`
// renders down to the native `RCTModalHostView`, which carries `onRequestClose` as
// one of its own host props (`Modal.js`), so read it off that node rather than firing
// a DOM-style event `fireEvent` has no mapping for.
//
// `screen.container`, not `screen.root`: `root` is only `container.children[0]`, the
// first top-level sibling, and several tests here render the Modal's host alongside
// an inline `<MentioraWidget />`.
const modalHosts = () =>
  screen.container.queryAll((node) => typeof node.props.onRequestClose === 'function', {
    includeSelf: true,
  });

const requestClose = (): void => {
  const [modal] = modalHosts();
  if (!modal) throw new Error('no Modal with onRequestClose found — call Mentiora.open() first');
  (modal.props.onRequestClose as () => void)();
};

// Drives `CRASH_RETRY_POLICY.attempts` (4) `onRenderProcessGone` failures to
// exhaustion. Re-queries `mentiora-webview` by testID on every iteration rather than
// caching the element, because the recovery bumps `remountKey` and swaps the WebView
// instance out from under a cached reference on every attempt but the last.
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

// An open-on-launch deep link or push-notification handoff: a screen calling
// `Mentiora.open()` from its own mount effect, with no control over where
// `<MentioraHost />` sits relative to it in the tree.
function OpenOnMount({ onError }: { onError: (error: unknown) => void }): null {
  useEffect(() => {
    Mentiora.open().catch(onError);
  }, [onError]);
  return null;
}

// Two hosts with stable identity (`key`) across a rerender, so removing one specific
// host is reachable: with plain positional children React reuses index 0 regardless
// of which logical host that was.
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
  // configure() + open() stand alone: the button may live on a different screen from
  // any embedded tab. A <MentioraHost /> still has to be mounted somewhere, but no
  // inline <MentioraWidget /> is needed.
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
  // A customer who configured but forgot to mount the host learns that, rather than
  // being told to call configure() again. One who did neither gets the configure
  // message, checked above, since that is the more fundamental gap.
  Mentiora.configure(cfg);
  await expect(Mentiora.open()).rejects.toThrow(/MentioraHost/);
});

test('two mounted hosts never render two Modals — the oldest-mounted one owns it', async () => {
  // One `<MentioraHost />` at the app root is the expected shape; two exist only
  // briefly during a screen transition. The rule is a total order — oldest-mounted
  // wins — rather than "last wins" or "undefined", so two Modals never show, not even
  // for one frame.
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
  // `activeHostId` is re-assigned to a surviving host when the active one unmounts,
  // never dropped to `null`: dropping it fails silently, since `open()` still
  // succeeds with a host mounted but nothing ever renders.
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
  // `useSyncExternalStore` subscribes in a passive effect, which runs in tree order,
  // so a host rendered after the screen calling `open()` from its own mount effect
  // has not subscribed yet. `open()`'s host check counts from render rather than
  // subscribe, so it must succeed regardless of sibling order.
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
  // StrictMode mounts effects, tears them down and mounts them again on the same
  // fiber without re-rendering. Counting `hostIds` membership at render alone means
  // the push runs once and the subscribe cleanup's splice runs twice, deregistering
  // the host permanently: `open()` then throws "needs <MentioraHost /> mounted" at an
  // app whose host is mounted — every new RN/Expo app, whose templates wrap the root
  // in StrictMode.
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
  // Deliberately asymmetric with `logout()` below, which throws in the equivalent
  // case: there is nothing to undo here, so unifying the two guards would be wrong
  // rather than merely redundant.
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
  // Silently resolving here strands the previous user's install id and `wasSignedIn`
  // flag in storage, with nothing to diagnose it by.
  await expect(Mentiora.logout()).rejects.toThrow(/configure/);
});

test('logout with the Modal closed and no inline widget still rotates the install id', async () => {
  // Asserts the real-runtime side effect: a `logout()` that does nothing at all also
  // resolves its promise.
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
  // `logout()` reloads whichever widgets are mounted, including an inline one and not
  // only the Modal's: `MentioraWidget` subscribes to `runtime.onReload` itself, so a
  // test registering its own runtime listener cannot catch a widget that never
  // subscribed.
  //
  // Asserting only that the WebView instance changed tests the mechanism, not the
  // outcome, and that gap is how a remount with no load boundary gets through.
  // Without `beginFreshLoad()`, and so without `peer.resetLoad()`, the remounted page
  // is dead: its `initialize` is answered `-32600 "initialize already completed for
  // this page load"`, that rejection is stamped with the pre-logout session key, and
  // the peer goes on authorizing that key for the next user's page. The outcome is
  // what is asserted: the fresh page handshakes, and nothing sent to it carries the
  // previous session's key.
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
  // Throws ("no installId in the handshake reply") if the page got `-32600` instead
  // of a result, which is what a remount skipping the load boundary produces.
  expect(await handshakeInstallId(screen.getByTestId('mentiora-webview'))).toEqual(
    expect.any(String),
  );
  expect(
    sentFrom(after).map((message) => (message.params as { sessionKey?: string })?.sessionKey),
  ).not.toContain(keyBefore);
});

test('logout clears a stale error surface instead of leaving it over the fresh page', async () => {
  // Logout and Retry both run the same `restartLoad`. A reload handler that does
  // `beginFreshLoad()` + `setRemountKey` and stops, while Retry also clears
  // `errorCode` and every ladder counter, leaves a logout from the error screen with
  // "something went wrong" covering a healthy, freshly rotated page.
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
  // A session first, so the page can claim the button, then the crash ladder. The
  // WebView stays mounted under the error surface — marked
  // `importantForAccessibility`, never unmounted — so the registration from before
  // the crash is still the one `onRequestClose` reads.
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
  // `includeHiddenElements` because the WebView under the error surface is marked
  // `importantForAccessibility="no-hide-descendants"`, which RNTL's queries exclude
  // by default: a plain `queryByTestId` reads `null` — looking dismissed — while it
  // is still mounted.
  expect(screen.queryByTestId('mentiora-webview', { includeHiddenElements: true })).toBeNull();
  expect(
    sentFrom(view)
      .slice(sentBeforeClose)
      .some((message) => message.method === 'mentiora/back'),
  ).toBe(false);
});

test('a transient reload does not leave the Modal back button dead', async () => {
  // `onHardwareBack` re-checks `peer.sessionKey() !== null` at press time rather
  // than reading a stale flag. A single transient load failure resets the session key
  // (`advanceGeneration` -> `peer.resetLoad()`) without ever showing the error
  // surface, since `LOAD_RETRY_POLICY.attempts` is 3 and one failure just schedules a
  // reload. Asking "is there an entry in the map?" instead gets a stale yes and calls
  // a `sendBack()` that no-ops once the session is gone, never dismissing.
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
  // Captured before `requestClose()`: dismissing unmounts the WebView and
  // `sent()`/`__lastWebView()` throw once none is mounted, while this ref object and
  // its call history stay good.
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

test('an inline widget on the same embed key does not hijack the Modal back channel', async () => {
  // A header button opening the Modal and a tab embedding <MentioraWidget /> on the
  // same embed key. Keying the back channel by embedKey lets whichever widget last
  // claimed the button under that key answer for both.
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

  // Keyed per widget instance, through a context, so the inline widget's
  // registration is never consulted: the Modal dismisses on its own widget's
  // unclaimed back state and the inline widget's page is sent nothing.
  expect(screen.getAllByTestId('mentiora-webview')).toHaveLength(1); // only the inline one left
  expect(
    sentFrom(inlineView)
      .slice(inlineSentBefore)
      .some((message) => message.method === 'mentiora/back'),
  ).toBe(false);
});

test('after Retry recovers from an error, the Modal honours a fresh back hold again', async () => {
  // `onHardwareBack`'s `errorCode !== null` check is read live, so it re-enables
  // itself the moment Retry clears the surface. A `blocked`-style one-way latch that
  // Retry does not clear leaves every future back press dismissing the Modal for the
  // rest of its life, even on a fresh, healthy session.
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

test('a host onEvent that throws on close still lets the presenter close the Modal', async () => {
  // The wrapper does its own bookkeeping before calling the host's `onEvent`.
  // `MentioraWidget`'s Dismiss path wraps its own `onEvent` call in try/catch, so a
  // `Mentiora.close()` running after a throwing host callback is swallowed as
  // collateral, stranding a `visible={true}` Modal over the blank `<View />` Dismiss
  // just rendered, with no escape on iOS, where `onRequestClose` never fires.
  const throwingConfig = {
    ...cfg,
    onEvent: (event: { type: string }): void => {
      // Only `close` throws. `error` fires first, driving the ladder to exhaustion
      // below, and a throw there would land somewhere other than the point under
      // test.
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
  // The line above passes even when `Mentiora.close()` never ran: `MentioraWidget`'s
  // Dismiss path calls `setDismissed(true)` and renders `<View />` before calling
  // `onEvent`, so the WebView is gone either way. The Modal is what gets stranded, so
  // the Modal is what has to be asserted gone. Fails with
  // `Received array: [<Modal onRequestClose={...} visible={true}>...]` when
  // `Mentiora.close()` runs after `config.onEvent?.(event)` in `ModalBody`.
  expect(modalHosts()).toHaveLength(0);
});

// A `<MentioraHost />` that renders and never commits leaves an id in `hostIds` that
// nothing splices out, sitting at index 0 because it was pushed first. A teardown
// handing ownership to `hostIds[0]` rather than `subscribedIds[0]` therefore hands it
// to the phantom the first time a real host unmounts, and every surviving host
// renders `null` for the rest of the process: `open()` resolves and nothing appears.
//
// `<Suspense>` in an app root is ordinary — `React.lazy`, React Navigation's lazy
// screens, a `use()`d promise — and so is a discarded render from an interrupted
// transition.
function Suspends({ gate }: { gate: Promise<void> }): null {
  throw gate;
}

test('a host render that never commits can never end up owning the Modal', async () => {
  Mentiora.configure(cfg);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  // The phantom: this `<MentioraHost />` renders, pushing its id, and is discarded
  // with the rest of the boundary when its sibling suspends.
  const view = await render(
    <Suspense fallback={null}>
      <MentioraHost />
      <Suspends gate={gate} />
    </Suspense>,
  );
  release();
  expect(screen.queryByTestId('mentiora-webview')).toBeNull();

  // Now the ordinary screen transition: host "a" owns the Modal, then
  // unmounts while host "b" survives.
  await view.rerender(<TwoHosts showFirst={true} />);
  await act(async () => {
    await Mentiora.open();
  });
  expect(screen.getAllByTestId('mentiora-webview')).toHaveLength(1);
  await view.rerender(<TwoHosts showFirst={false} />);
  await waitFor(() => {
    expect(screen.getAllByTestId('mentiora-webview')).toHaveLength(1);
  });
});

// A dismissed widget keeps its `runtime.onReload` subscription, so `restartLoad`
// clears `dismissed` too. Without `setDismissed(false)` there, `Mentiora.logout()`
// runs the whole fresh-start path against a widget rendering a blank `<View />`: a
// remount key bump and a fresh watchdog on a WebView nobody renders, and a
// `handshake_timeout` handed to the host ~16s later for a surface the user closed.
test('logout revives a dismissed inline widget rather than restarting a blank one', async () => {
  Mentiora.configure(cfg);
  const onEvent = jest.fn();
  await render(<MentioraWidget {...cfg} onEvent={onEvent} />);
  await driveCrashLadderToExhaustion();
  await act(async () => {
    await fireEvent.press(screen.getByRole('button', { name: DEFAULT_STRINGS.dismiss }));
  });
  expect(screen.queryByTestId('mentiora-webview', { includeHiddenElements: true })).toBeNull();

  await act(async () => {
    await Mentiora.logout();
  });

  // The fresh start is real: a page again, and one that can speak.
  expect(await handshakeInstallId(screen.getByTestId('mentiora-webview'))).toEqual(
    expect.any(String),
  );
  // And no error event for a surface that was never on screen, over two watchdog
  // cycles' worth of time — long enough for the spurious one to arrive.
  await act(async () => {
    await jest.advanceTimersByTimeAsync(20000);
  });
  expect(onEvent).not.toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
});

// `hostIds` is pushed to from the layout phase, not the render body. From the render
// body, a host that renders and is thrown away — a `<Suspense>` sibling suspending,
// an interrupted transition, StrictMode's double render — leaves its id there
// forever, and since `open()` sets `visible: true` with nothing clearing it, the next
// host to actually commit pops a Modal with no `open()` behind it. The layout phase
// keeps the same-commit and StrictMode cases above green, because every layout effect
// in a commit runs before any passive effect, while only committed renders count.
test('a host render that never commits neither satisfies open() nor pops a Modal', async () => {
  Mentiora.configure(cfg);
  const gate = new Promise<void>(() => {}); // never settles: the boundary stays in fallback
  const view = await render(
    <Suspense fallback={null}>
      <MentioraHost />
      <Suspends gate={gate} />
    </Suspense>,
  );

  await act(async () => {
    await expect(Mentiora.open()).rejects.toThrow(/MentioraHost/);
  });

  // And a host that commits later must not inherit a `visible` nobody set.
  await view.rerender(<MentioraHost />);
  expect(screen.queryByTestId('mentiora-webview')).toBeNull();
});
