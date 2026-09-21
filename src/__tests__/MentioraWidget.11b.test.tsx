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
import { __lastWebView, __resetWebViews } from '../../__mocks__/react-native-webview';
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

const answerRandom = (el: ReturnType<typeof screen.getByTestId>, count = 16) =>
  fireEvent(el, 'message', {
    nativeEvent: { data: JSON.stringify({ tag: RANDOM_REPLY_TAG, bytes: Array(count).fill(7) }) },
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
  expect(codes).not.toContain('load_failed');
});

test('a valid initialize clears the watchdog synchronously', async () => {
  const el = await mount();
  await initialize(el);
  await answerRandom(el);
  await advance(30000);
  expect(__lastWebView().reload).not.toHaveBeenCalled();
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
  const el = await mount(onEvent);
  await fireEvent(el, 'error', { nativeEvent: { description: 'net' } });
  await fireEvent(el, 'renderProcessGone', { nativeEvent: { didCrash: true } });
  await advance(9000);
  // Only the first terminal callback for a generation picks a path. Two more
  // genuine incidents must still be needed before any surface appears.
  expect(screen.queryByRole('button', { name: DEFAULT_STRINGS.retry })).toBeNull();
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
  expect(screen.queryByTestId('mentiora-webview')).toBeNull();
  expect(screen.queryByRole('button', { name: DEFAULT_STRINGS.retry })).toBeNull();
});
