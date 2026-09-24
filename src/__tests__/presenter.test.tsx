// `Mentiora.open()/close()/logout()` presenting `<MentioraWidget />` in the warm overlay.

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
const WIDGET_URL = `${ORIGIN}/h/rn/${KEY}`;
const cfg = { widgetUrl: WIDGET_URL };

beforeEach(() => {
  __resetRuntimes();
  __resetWebViews();
  __resetPresenter();
  Mentiora.close();
});

// Fake timers file-wide: Jest only intercepts a `setTimeout` created after
// `useFakeTimers()`, so switching mid-test leaves an already-mounted widget's timers loose.
beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

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

// Every send past the handshake carries `params.sessionKey` (peer.ts `withSessionParams`).
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

/**
 * Android back, dispatched as RN dispatches it: newest subscriber first, stopping at the
 * first handler that returns `true`. There is no `Modal` any more, so this is the whole
 * path — the overlay subscribes after the widget it contains (React flushes child effects
 * first), which is what makes the overlay's claim outrank the widget's.
 */
/** Parked means mounted and warm but off-screen: inert to touches and to a11y. */
const overlayParked = (): boolean =>
  screen.getByTestId('mentiora-overlay', { includeHiddenElements: true }).props.pointerEvents ===
  'none';

const pressBack = (): boolean => {
  const handlers = (globalThis as unknown as { __backHandlers: Array<() => boolean> })
    .__backHandlers;
  if (handlers.length === 0) throw new Error('nothing registered for hardwareBackPress');
  for (const handler of [...handlers].reverse()) if (handler()) return true;
  return false;
};

// Drives the crash policy's 4 attempts to exhaustion, re-querying by testID each time:
// the recovery bumps `remountKey` and swaps the instance out from under a cached one.
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

// A deep-link handoff: `Mentiora.open()` from a mount effect, with the host anywhere in the tree.
function OpenOnMount({ onError }: { onError: (error: unknown) => void }): null {
  useEffect(() => {
    Mentiora.open().catch(onError);
  }, [onError]);
  return null;
}

// Stable `key`s, so removing one specific host is reachable; positional children reuse index 0.
function TwoHosts({ showFirst }: { showFirst: boolean }): React.JSX.Element {
  return (
    <>
      {showFirst && <MentioraHost key="a" />}
      <MentioraHost key="b" />
    </>
  );
}

test('open shows the overlay and close parks it', async () => {
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
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  expect(screen.getByTestId('mentiora-webview')).toBeTruthy();
});

test('configure with a malformed widgetUrl throws at startup, naming the expected shape', () => {
  // An origin without the `/h/rn/<key>` path is the likely mistake after the rename.
  expect(() => Mentiora.configure({ widgetUrl: ORIGIN })).toThrow(/widgetUrl.*\/h\/rn\//);
});

test('open before configure throws a clear error naming the missing call', async () => {
  await expect(Mentiora.open()).rejects.toThrow(/configure/);
});

test('open throws a distinct error naming MentioraHost when configured but no host is mounted', async () => {
  Mentiora.configure(cfg);
  await expect(Mentiora.open()).rejects.toThrow(/MentioraHost/);
});

test('two mounted hosts never render two overlays — the oldest-mounted one owns it', async () => {
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

test('after the active host unmounts, a surviving host takes over the overlay', async () => {
  // `activeHostId` moves to a survivor, never `null`: dropping it lets `open()` succeed silently.
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
  // A host rendered after the screen calling `open()` has not subscribed; the check counts renders.
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
  // StrictMode remounts effects without re-rendering, so a render-time push runs once while
  // the cleanup's splice runs twice and deregisters a host that is mounted.
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
  // Asymmetric with `logout()` on purpose: there is nothing to undo here.
  expect(() => {
    Mentiora.close();
  }).not.toThrow();
});

test('reopening reuses the warm WebView — no remount, no reload', async () => {
  // The reverse of what this file used to assert. Closing parks the overlay instead of
  // unmounting it, so the document and its JS context survive and the second open costs
  // a transform. Neither a new instance nor a `reload()` may appear.
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  const first = __lastWebView();
  await handshake(screen.getByTestId('mentiora-webview'));
  await act(async () => {
    Mentiora.close();
  });
  expect(overlayParked()).toBe(true);
  await act(async () => {
    await Mentiora.open();
  });
  expect(__lastWebView()).toBe(first);
  expect(first.reload).not.toHaveBeenCalled();
  expect(overlayParked()).toBe(false);
});

test('a warm show tells the page it is on screen again', async () => {
  // The page's launch signal is once-per-document. Reused, it never fires again, so the
  // second open would be invisible to the widget's own dwell and open/close funnel.
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  await handshake(screen.getByTestId('mentiora-webview'));
  await act(async () => {
    Mentiora.close();
  });
  const before = sent().length;
  await act(async () => {
    await Mentiora.open();
  });
  expect(sent().slice(before).at(-1)).toMatchObject({ method: 'mentiora/show' });
});

test('parking tells the page it left the screen', async () => {
  // Back and `close()` park the overlay without the page's own close button, so without
  // this the page's open never ends and its dwell keeps growing.
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  await handshake(screen.getByTestId('mentiora-webview'));
  const before = sent().length;
  await act(async () => {
    Mentiora.close();
  });
  expect(sent().slice(before)).toEqual([
    { jsonrpc: '2.0', method: 'mentiora/hide', params: { sessionKey: currentSessionKey() } },
  ]);
});

test('the handshake tells the page whether it is on screen', async () => {
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  await handshake(screen.getByTestId('mentiora-webview'));
  await waitFor(() => {
    expect(sent().at(-1)).toMatchObject({ result: { visible: true } });
  });
});

test('a document loaded while parked is told it is off screen', async () => {
  // An identity change reloads the parked overlay. Told nothing, the new document counts
  // an open on `ready` that nobody saw.
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  const first = __lastWebView();
  await handshake(screen.getByTestId('mentiora-webview'));
  await act(async () => {
    Mentiora.close();
  });
  await act(async () => {
    Mentiora.configure({ ...cfg, identity: { getToken: () => 't1' } });
  });
  expect(__lastWebView()).not.toBe(first);
  // Parked, the overlay is hidden from screen readers and so from RNTL's default query.
  await handshake(screen.getByTestId('mentiora-webview', { includeHiddenElements: true }));
  await waitFor(() => {
    expect(sent().at(-1)).toMatchObject({ result: { visible: false } });
  });
});

test('configure with a NEW identity reloads the warm page; an unchanged one does not', async () => {
  // Warm, no second `initialize` runs, so a signed-in user reopening would otherwise keep
  // the anonymous credential the page booted with.
  const identity = { getToken: () => 't1' };
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  const view = __lastWebView();
  await handshake(screen.getByTestId('mentiora-webview'));
  await act(async () => {
    Mentiora.close();
  });

  // `strings` changes freely: only identity may cost a reload.
  await act(async () => {
    Mentiora.configure({ ...cfg, strings: { ...DEFAULT_STRINGS } });
  });
  expect(view.reload).not.toHaveBeenCalled();

  await act(async () => {
    Mentiora.configure({ ...cfg, identity });
  });
  expect(screen.getByTestId('mentiora-webview', { includeHiddenElements: true })).toBeTruthy();
  expect(__lastWebView()).not.toBe(view); // restartLoad remounts, which is a fresh document
});

test('a warm reopen does not arm a watchdog — no second initialize is coming', async () => {
  // The document already handshaked, so an armed watchdog has nothing to disarm it and
  // would silently reload a working widget one budget later.
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  const view = __lastWebView();
  await handshake(screen.getByTestId('mentiora-webview'));
  await act(async () => {
    Mentiora.close();
  });
  await act(async () => {
    await Mentiora.open();
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(20000);
  });
  expect(view.reload).not.toHaveBeenCalled();
  expect(__lastWebView()).toBe(view);
});

test('a parked widget does not claim the host app back button', async () => {
  // Mounted no longer implies on screen. A page still holding back must not swallow
  // presses meant for the host app's own navigator.
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  const el = screen.getByTestId('mentiora-webview');
  await handshake(el);
  await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
  await act(async () => {
    Mentiora.close();
  });
  const view = __lastWebView();
  const before = sentFrom(view).length;
  expect(pressBack()).toBe(false);
  expect(
    sentFrom(view)
      .slice(before)
      .some((message) => message.method === 'mentiora/back'),
  ).toBe(false);
});

test('logout before configure throws, naming the missing call', async () => {
  // Silently resolving strands the previous user's install id and `wasSignedIn` flag.
  await expect(Mentiora.logout()).rejects.toThrow(/configure/);
});

test('logout with the overlay parked and no inline widget still rotates the install id', async () => {
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
  // The widget subscribes to `runtime.onReload` itself, so a test listener cannot stand in.
  // Without `beginFreshLoad()` the remounted page's `initialize` gets -32600 under the old key.
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
  // Throws if the page got -32600 instead of a result — a remount with no load boundary.
  expect(await handshakeInstallId(screen.getByTestId('mentiora-webview'))).toEqual(
    expect.any(String),
  );
  expect(
    sentFrom(after).map((message) => (message.params as { sessionKey?: string })?.sessionKey),
  ).not.toContain(keyBefore);
});

test('logout clears a stale error surface instead of leaving it over the fresh page', async () => {
  // Logout and Retry share `restartLoad`: skip clearing `errorCode` and the error screen survives.
  Mentiora.configure(cfg);
  await render(<MentioraWidget {...cfg} />);
  await driveCrashLadderToExhaustion();
  expect(screen.getByRole('button', { name: DEFAULT_STRINGS.retry })).toBeTruthy();

  await act(async () => {
    await Mentiora.logout();
  });

  expect(screen.queryByRole('button', { name: DEFAULT_STRINGS.retry })).toBeNull();
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

test('android back forwards mentiora/back to the page while it holds the button, and stays open', async () => {
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  const el = screen.getByTestId('mentiora-webview');
  await handshake(el);
  await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
  await act(async () => {
    pressBack();
  });
  expect(sent().at(-1)).toMatchObject({ method: 'mentiora/back' });
  expect(screen.getByTestId('mentiora-webview')).toBeTruthy();
});

test('android back closes only once the page released the back button', async () => {
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  const el = screen.getByTestId('mentiora-webview');
  await handshake(el);
  await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
  await act(async () => {
    pressBack();
  });
  expect(screen.queryByTestId('mentiora-webview')).toBeTruthy();
  await fireEvent(el, 'message', { nativeEvent: { data: backHandling(false) } });
  await act(async () => {
    pressBack();
  });
  expect(screen.queryByTestId('mentiora-webview')).toBeNull(); // now it dismisses
});

test('android back closes even while the page holds back, once the error surface is up', async () => {
  // The WebView stays mounted under the error surface, so its pre-crash registration still reads.
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
    pressBack();
  });
  // The WebView stays mounted and warm; parking the overlay is what "dismissed" means now.
  expect(overlayParked()).toBe(true);
  expect(
    sentFrom(view)
      .slice(sentBeforeClose)
      .some((message) => message.method === 'mentiora/back'),
  ).toBe(false);
});

test('a transient reload does not leave the overlay back button dead', async () => {
  // `onHardwareBack` re-checks `peer.sessionKey()` at press time: one transient load failure
  // resets the key with no error surface, and a stale flag then sends back to nobody.
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
  // Captured before `requestClose()`: `__lastWebView()` throws once none is mounted.
  const view = __lastWebView();
  const sentBeforeClose = sentFrom(view).length;
  await act(async () => {
    pressBack();
  });
  expect(screen.queryByTestId('mentiora-webview')).toBeNull();
  expect(
    sentFrom(view)
      .slice(sentBeforeClose)
      .some((message) => message.method === 'mentiora/back'),
  ).toBe(false);
});

test('an inline widget on the same embed key does not hijack the overlay back channel', async () => {
  // Two widgets on one embed key: keying the back channel by embedKey would cross them.
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
  await act(async () => {
    pressBack();
  });

  // Keyed per widget instance through a context, so the inline widget is never consulted.
  expect(screen.getAllByTestId('mentiora-webview')).toHaveLength(1); // only the inline one left
  expect(
    sentFrom(inlineView)
      .slice(inlineSentBefore)
      .some((message) => message.method === 'mentiora/back'),
  ).toBe(false);
});

test('after Retry recovers from an error, the overlay honours a fresh back hold again', async () => {
  // `errorCode !== null` is read live, so Retry re-enables back; a latch would never clear.
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
    pressBack();
  });
  expect(sent().at(-1)).toMatchObject({ method: 'mentiora/back' });
  expect(screen.getByTestId('mentiora-webview')).toBeTruthy();
});

test('a host onEvent that throws on close still lets the presenter park the overlay', async () => {
  // The wrapper must do its bookkeeping before the host's `onEvent`: the Dismiss path's
  // try/catch would swallow a later `Mentiora.close()`, stranding a visible Modal.
  const throwingConfig = {
    ...cfg,
    onEvent: (event: { type: string }): void => {
      // Only `close` throws: `error` fires first and a throw there misses the point.
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
  // The line above passes even when `Mentiora.close()` never ran, since Dismiss renders
  // `<View />` first either way. The overlay is what gets stranded, so assert the overlay.
  expect(overlayParked()).toBe(true);
});

// A host that renders and never commits leaves a phantom id at `hostIds[0]`. Ownership must
// pass to `subscribedIds[0]`, or the phantom takes it on the first real unmount and every
// surviving host renders `null` for the rest of the process.
function Suspends({ gate }: { gate: Promise<void> }): null {
  throw gate;
}

test('a host render that never commits can never end up owning the Modal', async () => {
  Mentiora.configure(cfg);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  // The phantom: renders and pushes its id, then is discarded when its sibling suspends.
  const view = await render(
    <Suspense fallback={null}>
      <MentioraHost />
      <Suspends gate={gate} />
    </Suspense>,
  );
  release();
  expect(screen.queryByTestId('mentiora-webview')).toBeNull();

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

// Without `setDismissed(false)` in `restartLoad`, a logout arms a watchdog on a hidden WebView.
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

  expect(await handshakeInstallId(screen.getByTestId('mentiora-webview'))).toEqual(
    expect.any(String),
  );
  // And no error event over two watchdog cycles, long enough for a spurious one to arrive.
  await act(async () => {
    await jest.advanceTimersByTimeAsync(20000);
  });
  expect(onEvent).not.toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
});

// `hostIds` is pushed from the layout phase. Pushed from the render body, a discarded render
// leaves its id forever and the next host to commit pops a Modal with no `open()` behind it.
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

  await view.rerender(<MentioraHost />);
  expect(screen.queryByTestId('mentiora-webview')).toBeNull();
});
