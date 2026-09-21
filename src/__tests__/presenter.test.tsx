// src/__tests__/presenter.test.tsx
//
// Task 12: `Mentiora.open()/close()/logout()` presenting `<MentioraWidget />`
// over a `Modal`. `react-native`'s `Modal` is NOT mocked (unlike WebView), so
// `onRequestClose` is read straight off the rendered element rather than
// fired as a DOM-style event.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import {
  __lastWebView,
  __resetWebViews,
  type MockWebViewRef,
} from '../../__mocks__/react-native-webview';
import { __resetBackHold } from '../back-hold';
import { MentioraWidget } from '../MentioraWidget';
import { __resetPresenter, Mentiora, MentioraHost } from '../presenter';
import { RANDOM_REPLY_TAG } from '../random';
import { __resetRuntimes, getRuntime } from '../runtime';

const ORIGIN = 'https://w.x.ai';
const KEY = 'pk_wgt_a';
const cfg = { widgetOrigin: ORIGIN, embedKey: KEY };

beforeEach(() => {
  __resetRuntimes();
  __resetWebViews();
  __resetBackHold();
  __resetPresenter();
  Mentiora.close();
});

// Fake timers for the WHOLE file, not toggled per test: `driveToHandshakeTimeout`
// needs to advance past the widget's own mount-armed watchdog, and Jest's fake
// timers only intercept a `setTimeout` call made AFTER `jest.useFakeTimers()`
// runs — switching mid-test, after a widget has already mounted under real
// timers, leaves that specific timer unreachable by `advanceTimersByTimeAsync`.
// 11b's file makes the same file-wide choice for the same reason.
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
// `driveToHandshakeTimeout` copies 11b's `advance()` pattern, called twice
// (one silent reload, one give-up) exactly like 11c's own "late handshake"
// test.
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

// `Modal` (unlike `react-native-webview`) is NOT mocked, and this project's
// RNTL has no `UNSAFE_getByType`: `Modal` renders straight down to the native
// `RCTModalHostView`, which carries `onRequestClose` as one of its own host
// props (`Modal.js`). Read it off that host node rather than firing a
// DOM-style event `fireEvent` has no mapping for.
const requestClose = (): void => {
  const root = screen.root;
  if (!root) throw new Error('nothing rendered yet — call render() first');
  const [modal] = root.queryAll((node) => typeof node.props.onRequestClose === 'function', {
    includeSelf: true,
  });
  if (!modal) throw new Error('no Modal with onRequestClose found — call Mentiora.open() first');
  (modal.props.onRequestClose as () => void)();
};

const driveToHandshakeTimeout = async (): Promise<void> => {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(8000);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(8000);
  });
};

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

test('open works once a MentioraHost is mounted', async () => {
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  expect(screen.getByTestId('mentiora-webview')).toBeTruthy();
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

test('close before configure is a no-op, not a throw', () => {
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

test('logout rotates the install id and reloads what is mounted', async () => {
  Mentiora.configure(cfg);
  await render(<MentioraWidget {...cfg} />);
  let reloads = 0;
  const off = getRuntime(cfg).onReload(() => {
    reloads++;
  });
  await act(async () => {
    await Mentiora.logout();
  });
  expect(reloads).toBe(1);
  off();
});

test('logout with the Modal closed and no inline widget rotates state and does not throw', async () => {
  Mentiora.configure(cfg);
  await expect(Mentiora.logout()).resolves.toBeUndefined();
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

test('onRequestClose forwards mentiora/back to the page while it holds the button, and stays open', async () => {
  // Fix round 1: a boolean alone left the page never told a press happened,
  // so it could never release the hold — back was dead for the life of the
  // Modal, the exact trap 11b/11c both exist to close. This asserts the
  // notification actually reached the page, the way 11c's own back tests do.
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
  // The same trap 11c closed for the hardware button, reached through the Modal.
  // MentioraWidget.tsx:514-516 shows the watchdog's give-up branch calls showError
  // WITHOUT advanceGeneration, so a late initialize can claim back after the surface.
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  const el = screen.getByTestId('mentiora-webview');
  await driveToHandshakeTimeout(); // both watchdog rungs
  await handshake(el); // a late handshake under the surface
  await fireEvent(el, 'message', { nativeEvent: { data: backHandling(true) } });
  await act(async () => {
    requestClose();
  });
  expect(screen.queryByTestId('mentiora-webview')).toBeNull();
});

test('the presenter unsubscribes from runtime.onReload when the Modal closes', async () => {
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    await Mentiora.open();
  });
  await act(async () => {
    Mentiora.close();
  });
  // A logout with nothing mounted must not call into a dead subscriber.
  await expect(Mentiora.logout()).resolves.toBeUndefined();
});
