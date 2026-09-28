// Shared by the Jest suites. Not a `.test.tsx`, so Jest never runs it as a suite.
import { fireEvent, type screen } from '@testing-library/react-native';
import { __lastWebView, type MockWebViewRef } from '../../__mocks__/react-native-webview';
import { RANDOM_REPLY_TAG } from '../random';

export const ORIGIN = 'https://w.x.ai';
export const KEY = 'pk_wgt_a';
export const WIDGET_URL = `${ORIGIN}/h/rn/${KEY}`;

type Element = ReturnType<typeof screen.getByTestId>;
type Message = Record<string, unknown>;

/** Every script the widget injected into `view`, in order. */
export const scripts = (view: MockWebViewRef = __lastWebView()): string[] =>
  (view.injectJavaScript as jest.Mock).mock.calls.map(([script]: [string]) => script);

const BRIDGE_INJECTION = /^window\.mentioraHost\.receive\((.*)\);true;$/s;

// Host-to-page only: the random-bytes request shares the channel but is not a bridge message.
export const sentFrom = (view: MockWebViewRef = __lastWebView()): Message[] =>
  scripts(view).flatMap((script) => {
    const m = BRIDGE_INJECTION.exec(script);
    return m ? [JSON.parse(JSON.parse(m[1] as string) as string) as Message] : [];
  });

export const sent = (): Message[] => sentFrom(__lastWebView());

export const randomScripts = (): string[] => scripts().filter((s) => s.includes(RANDOM_REPLY_TAG));

export const nonceOf = (script: string): string => {
  const m = /,k="([^"]+)"/.exec(script);
  if (!m) throw new Error('the injected random script carries no nonce');
  return m[1] as string;
};

/** Answers the newest random-bytes request as the page would. */
export const answerLastRandom = (el: Element, { count = 16, fill = 7 } = {}) => {
  const script = randomScripts().at(-1);
  if (script === undefined) throw new Error('no random request outstanding');
  return fireEvent(el, 'message', {
    nativeEvent: {
      data: JSON.stringify({
        tag: RANDOM_REPLY_TAG,
        nonce: nonceOf(script),
        bytes: Array(count).fill(fill),
      }),
    },
  });
};

/** The page's `mentiora/initialize` request, id `r1`. */
export const initialize = (el: Element, protocolVersion = 1) =>
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

export const currentSessionKey = (view?: MockWebViewRef): string => {
  const last = sentFrom(view).at(-1) as { params?: { sessionKey?: string } } | undefined;
  const key = last?.params?.sessionKey;
  if (typeof key !== 'string') throw new Error('no session key yet — call initialize() first');
  return key;
};

export const backHandling = (active: boolean, view?: MockWebViewRef): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'mentiora/backHandling',
    params: { sessionKey: currentSessionKey(view), active },
  });
