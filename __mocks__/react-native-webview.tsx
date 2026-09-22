// react-native-webview ships no official Jest mock, so this is it, and every
// component test in the repo is written against this surface.
//
// The file must stay at the repo root in `__mocks__/`, adjacent to
// `node_modules`: Jest auto-applies a node-module mock only from there. One
// under `src/__mocks__` is silently ignored and the real WebView renders
// instead, with no error.
//
// Every callback the real WebView accepts is forwarded onto the rendered View's
// props so `fireEvent(el, '<name>', payload)` finds it — RNTL's fireEvent looks
// up `on${Capitalized(name)}` on the fired-on element or an ancestor.
// `injectJavaScript`, `reload` and `goBack` are `jest.fn()`s on the ref (one
// persistent instance per mounted WebView) and also on the module-level
// `__webViews` registry, because a test rendering `<MentioraWidget />` cannot
// reach the widget's own ref, and every host-to-page message goes through it.
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { ViewProps } from 'react-native';
import { View } from 'react-native';

type WebViewEvent = { nativeEvent: Record<string, unknown> };
type WebViewEventHandler = (event: WebViewEvent) => void;

// Not wrapped in `nativeEvent`, unlike the other eight callbacks. The library
// declares `OnShouldStartLoadWithRequest = (event: ShouldStartLoadRequest) =>
// boolean` (WebViewTypes.d.ts:172) where `ShouldStartLoadRequest extends
// WebViewNavigation` (:62): `url` and `isTopFrame` arrive at the top level, while
// the other callbacks are `NativeSyntheticEvent<…>` (:95-100). Wrapping this one
// too would teach the component to read `event.nativeEvent.url`, which is
// undefined in production, so `isSameOrigin(undefined, …)` would deny every
// navigation including the widget's own.
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

  // `source` is forwarded like every other prop rather than stripped: a test
  // asserting which URL the widget loads has nowhere else to read it from.
  return <View {...props} />;
});

WebView.displayName = 'WebView';

export default WebView;
