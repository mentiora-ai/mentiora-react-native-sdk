import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { AppStateStatus } from 'react-native';
import { __lastWebView, __resetWebViews } from '../../__mocks__/react-native-webview';
import { installRefOf } from '../install-id';
import { MentioraWidget } from '../MentioraWidget';
import { __resetPresenter, Mentiora, MentioraHost } from '../presenter';
import { __resetRuntimes, getRuntime } from '../runtime';
import { sent, WIDGET_URL } from './helpers';

const cfg = { widgetUrl: WIDGET_URL };

beforeEach(() => {
  __resetRuntimes();
  __resetWebViews();
  __resetPresenter();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

const setAppState = (s: AppStateStatus): void =>
  (globalThis as unknown as { __setAppState: (s: AppStateStatus) => void }).__setAppState(s);

const methods = (from = 0): unknown[] =>
  sent()
    .slice(from)
    .map((m) => m.method);

const webview = () => screen.getByTestId('mentiora-webview', { includeHiddenElements: true });

const post = async (message: Record<string, unknown>): Promise<void> => {
  await fireEvent(webview(), 'message', {
    nativeEvent: { data: JSON.stringify({ jsonrpc: '2.0', ...message }) },
  });
};

const handshake = async (): Promise<Record<string, unknown>> => {
  await post({ id: 'r1', method: 'mentiora/initialize', params: { protocolVersion: 1 } });
  await waitFor(() => {
    expect(sent().some((m) => m.id === 'r1')).toBe(true);
  });
  return (sent().find((m) => m.id === 'r1') as { result: Record<string, unknown> }).result;
};

const sessionKey = (): string => {
  const reply = sent().find((m) => m.id === 'r1') as { result: { sessionKey: string } };
  return reply.result.sessionKey;
};

const notifyFromPage = async (method: string, params: Record<string, unknown> = {}) => {
  await post({ method, params: { sessionKey: sessionKey(), ...params } });
};

const openOverlay = async (): Promise<void> => {
  Mentiora.configure(cfg);
  await render(<MentioraHost />);
  await act(async () => {
    Mentiora.open();
  });
};

describe('background counts as hidden', () => {
  test('backgrounding a visible widget sends hide; returning sends show', async () => {
    await openOverlay();
    await handshake();
    const before = sent().length;
    await act(async () => setAppState('background'));
    expect(methods(before)).toEqual(['mentiora/hide']);
    await act(async () => setAppState('active'));
    expect(methods(before)).toEqual(['mentiora/hide', 'mentiora/show']);
  });

  test('iOS inactive (Control Center, app switcher) sends nothing', async () => {
    await openOverlay();
    await handshake();
    const before = sent().length;
    await act(async () => setAppState('inactive'));
    await act(async () => setAppState('active'));
    expect(methods(before)).toEqual([]);
  });

  test('a parked widget stays silent across background and return', async () => {
    await openOverlay();
    await handshake();
    await act(async () => Mentiora.close());
    const before = sent().length;
    await act(async () => setAppState('background'));
    await act(async () => setAppState('active'));
    expect(methods(before)).toEqual([]);
  });

  test('opening while backgrounded defers show until the app returns', async () => {
    await openOverlay();
    await handshake();
    await act(async () => Mentiora.close());
    await act(async () => setAppState('background'));
    const before = sent().length;
    await act(async () => {
      Mentiora.open();
    });
    expect(methods(before)).toEqual([]);
    await act(async () => setAppState('active'));
    expect(methods(before)).toEqual(['mentiora/show']);
  });

  test('a page that loads while the app is backgrounded is told it is off screen', async () => {
    setAppState('background');
    await openOverlay();
    expect(await handshake()).toMatchObject({ visible: false });
  });

  test('returning to an errored widget does not reload it', async () => {
    const onEvent = jest.fn();
    await render(<MentioraWidget {...cfg} onEvent={onEvent} />);
    const first = __lastWebView();
    // Nothing handshakes, so the watchdog reloads once and then gives up.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(20_000);
    });
    expect(onEvent).toHaveBeenCalledWith({ type: 'error', code: 'handshake_timeout' });
    const reloads = (first.reload as jest.Mock).mock.calls.length;
    const instance = __lastWebView();
    await act(async () => setAppState('background'));
    await act(async () => setAppState('active'));
    expect(__lastWebView()).toBe(instance);
    expect((first.reload as jest.Mock).mock.calls.length).toBe(reloads);
  });
});

const openThread = async (threadId: string): Promise<void> => {
  await act(async () => {
    Mentiora.open({ threadId });
  });
};

describe('open({ threadId })', () => {
  test('a cold load carries the thread in the handshake, and sends no open after ready', async () => {
    Mentiora.configure(cfg);
    await render(<MentioraHost />);
    await openThread('thr_cold');
    expect(await handshake()).toMatchObject({ threadId: 'thr_cold' });
    const before = sent().length;
    await notifyFromPage('mentiora/ready');
    expect(methods(before)).toEqual([]);
  });

  test('a tap before configure and before the host mounts still lands on its thread', async () => {
    await act(async () => {
      Mentiora.open({ threadId: 'thr_early' });
    });
    Mentiora.configure(cfg);
    await render(<MentioraHost />);
    expect(await handshake()).toMatchObject({ threadId: 'thr_early' });
  });

  test('the latest held request wins', async () => {
    await act(async () => {
      Mentiora.open({ threadId: 'thr_one' });
      Mentiora.open({ threadId: 'thr_two' });
    });
    Mentiora.configure(cfg);
    await render(<MentioraHost />);
    expect(await handshake()).toMatchObject({ threadId: 'thr_two' });
  });

  test('a plain open does not drop a pending thread', async () => {
    Mentiora.configure(cfg);
    await render(<MentioraHost />);
    await openThread('thr_keep');
    await act(async () => {
      Mentiora.open();
    });
    expect(await handshake()).toMatchObject({ threadId: 'thr_keep' });
  });

  test('between the handshake and ready, the thread waits for ready', async () => {
    await openOverlay();
    await handshake();
    const before = sent().length;
    await openThread('thr_mid');
    expect(methods(before)).toEqual([]);
    await notifyFromPage('mentiora/ready');
    expect(sent().slice(before)).toEqual([
      {
        jsonrpc: '2.0',
        method: 'mentiora/open',
        params: { sessionKey: sessionKey(), threadId: 'thr_mid' },
      },
    ]);
  });

  test('a warm parked page gets open, then show', async () => {
    await openOverlay();
    await handshake();
    await notifyFromPage('mentiora/ready');
    await act(async () => Mentiora.close());
    const before = sent().length;
    await openThread('thr_warm');
    expect(methods(before)).toEqual(['mentiora/open', 'mentiora/show']);
    expect(sent()[before]).toMatchObject({ params: { threadId: 'thr_warm' } });
  });

  test('a delivered thread is not replayed into the next document', async () => {
    await openOverlay();
    await handshake();
    await notifyFromPage('mentiora/ready');
    await openThread('thr_once');
    await act(async () => {
      await Mentiora.logout();
    });
    expect(await handshake()).not.toHaveProperty('threadId');
  });

  test("logout drops an undelivered thread, so it never reaches the next user's page", async () => {
    Mentiora.configure(cfg);
    await render(<MentioraHost />);
    await openThread('thr_previous_user');
    await act(async () => {
      await Mentiora.logout();
    });
    expect(await handshake()).not.toHaveProperty('threadId');
  });
});

describe('push helpers', () => {
  test('isMentioraPush recognises the data block from either push library', () => {
    // expo-notifications: response.notification.request.content.data
    expect(Mentiora.isMentioraPush({ mentiora: '1', threadId: 'thr_a', other: 1 })).toBe(true);
    // React Native Firebase: remoteMessage.data, strings only
    expect(Mentiora.isMentioraPush({ mentiora: '1', threadId: 'thr_a', title: 'x' })).toBe(true);
    for (const data of [
      null,
      undefined,
      'mentiora',
      [],
      {},
      { mentiora: 1, threadId: 'thr_a' },
      { mentiora: '1' },
      { mentiora: '1', threadId: '' },
      { mentiora: '1', threadId: 7 },
      { threadId: 'thr_a' },
    ]) {
      expect(Mentiora.isMentioraPush(data)).toBe(false);
    }
  });

  test('handleNotificationOpen ignores foreign pushes and routes ours', async () => {
    Mentiora.configure(cfg);
    await render(<MentioraHost />);
    expect(Mentiora.handleNotificationOpen({ foo: 'bar' })).toBe(false);
    expect(screen.queryByTestId('mentiora-webview')).toBeNull();
    let handled = false;
    await act(async () => {
      handled = Mentiora.handleNotificationOpen({ mentiora: '1', threadId: 'thr_tap' });
    });
    expect(handled).toBe(true);
    expect(await handshake()).toMatchObject({ threadId: 'thr_tap' });
  });
});

describe('unreadCountChanged', () => {
  test('reaches the configured onEvent', async () => {
    const onEvent = jest.fn();
    Mentiora.configure({ ...cfg, onEvent });
    await render(<MentioraHost />);
    await act(async () => {
      Mentiora.open();
    });
    await handshake();
    await notifyFromPage('mentiora/unreadCountChanged', { count: 4 });
    expect(onEvent).toHaveBeenCalledWith({ type: 'unreadCountChanged', count: 4 });
  });
});

describe('installRef', () => {
  test('getInstallRef is null before the first open and matches the handshake id after', async () => {
    Mentiora.configure(cfg);
    expect(await Mentiora.getInstallRef()).toBeNull();
    await render(<MentioraHost />);
    await act(async () => {
      Mentiora.open();
    });
    const { installId } = (await handshake()) as { installId: string };
    expect(await Mentiora.getInstallRef()).toBe(installRefOf(installId));
  });

  test('getInstallRef before configure is null, so push registration at boot cannot race it', async () => {
    await expect(Mentiora.getInstallRef()).resolves.toBeNull();
  });

  test('installRefChanged reaches the overlay config exactly once per change', async () => {
    const onEvent = jest.fn();
    Mentiora.configure({ ...cfg, onEvent });
    await render(<MentioraHost />);
    await act(async () => {
      Mentiora.open();
    });
    const { installId } = (await handshake()) as { installId: string };
    const refEvents = () =>
      onEvent.mock.calls.filter(([e]: [{ type: string }]) => e.type === 'installRefChanged');
    expect(refEvents()).toEqual([
      [{ type: 'installRefChanged', installRef: installRefOf(installId) }],
    ]);
    await act(async () => {
      await Mentiora.logout();
    });
    expect(refEvents().at(-1)).toEqual([{ type: 'installRefChanged', installRef: null }]);
  });

  test("installRefChanged reaches configure()'s onEvent with no overlay mounted", async () => {
    const onEvent = jest.fn();
    Mentiora.configure({ ...cfg, onEvent });
    await getRuntime(cfg).installId(async (n) => new Uint8Array(n).fill(7));
    await Mentiora.logout();
    expect(onEvent).toHaveBeenCalledWith({ type: 'installRefChanged', installRef: null });
  });

  test('an inline widget forwards installRefChanged to its own onEvent', async () => {
    const onEvent = jest.fn();
    await render(<MentioraWidget {...cfg} onEvent={onEvent} />);
    const { installId } = (await handshake()) as { installId: string };
    expect(onEvent).toHaveBeenCalledWith({
      type: 'installRefChanged',
      installRef: installRefOf(installId),
    });
  });
});
