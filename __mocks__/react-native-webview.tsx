// react-native-webview ships no Jest mock; every component test targets this one. It must
// stay at the repo root in `__mocks__/`: Jest auto-mocks a node module only from there, and
// `src/__mocks__` is silently ignored while the real WebView renders. Callbacks are forwarded
// onto the View so RNTL's `fireEvent(el, '<name>')` finds `on${Name}`; the ref methods are
// also on `__webViews`, since a test cannot reach the widget's own ref.
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { ViewProps } from 'react-native';
import { View } from 'react-native';

type WebViewEvent = { nativeEvent: Record<string, unknown> };
type WebViewEventHandler = (event: WebViewEvent) => void;

// Unwrapped, unlike the other eight callbacks: `url` and `isTopFrame` arrive at the top
// level (WebViewTypes.d.ts:172, :62). Wrapping it would teach the component to read
// `event.nativeEvent.url`, undefined in production, denying every navigation.
type ShouldStartLoadRequest = { url: string; isTopFrame: boolean; navigationType?: string };

export type MockWebViewProps = ViewProps & {
  source?: unknown;
  onMessage?: WebViewEventHandler;
  onError?: WebViewEventHandler;
  onHttpError?: WebViewEventHandler;
  onLoadStart?: WebViewEventHandler;
  onLoadEnd?: WebViewEventHandler;
  onShouldStartLoadWithRequest?: (request: ShouldStartLoadRequest) => boolean | undefined;
  onOpenWindow?: WebViewEventHandler;
  onRenderProcessGone?: WebViewEventHandler;
  onContentProcessDidTerminate?: WebViewEventHandler;
};

export type MockWebViewRef = {
  injectJavaScript: (script: string) => void;
  reload: () => void;
  goBack: () => void;
};

const instances: MockWebViewRef[] = [];

/** Every mounted mock WebView, in mount order. */
export const __webViews = (): readonly MockWebViewRef[] => instances;

export const __lastWebView = (): MockWebViewRef => {
  const last = instances[instances.length - 1];
  if (!last) throw new Error('no WebView has mounted');
  return last;
};

export const __resetWebViews = (): void => {
  instances.length = 0;
};

export const WebView = forwardRef<MockWebViewRef, MockWebViewProps>((props, ref) => {
  const injectJavaScript = useRef(jest.fn()).current;
  const reload = useRef(jest.fn()).current;
  const goBack = useRef(jest.fn()).current;

  useImperativeHandle(ref, () => ({ injectJavaScript, reload, goBack }), [
    injectJavaScript,
    reload,
    goBack,
  ]);

  useEffect(() => {
    const api = { injectJavaScript, reload, goBack };
    instances.push(api);
    return () => {
      const i = instances.indexOf(api);
      if (i >= 0) instances.splice(i, 1);
    };
  }, [injectJavaScript, reload, goBack]);

  // `source` is forwarded, not stripped: a URL assertion has nowhere else to read it.
  return <View {...props} />;
});

WebView.displayName = 'WebView';

export default WebView;
