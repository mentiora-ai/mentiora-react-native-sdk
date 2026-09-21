// react-native-webview ships no official Jest mock (confirmed from the
// library's own open discussion). This is it, and it is public API: Tasks
// 10, 11a/b/c and 12 write every one of their component tests against this
// surface, not against the real WebView.
//
// This file must live at the repo root, in `__mocks__/`, adjacent to
// `node_modules` — Jest only auto-applies a node-module mock from a
// `__mocks__` directory there. One under `src/__mocks__` is silently
// ignored and the real WebView renders instead, with no error.
//
// Every callback the real WebView accepts is forwarded straight onto the
// rendered View's props, so `fireEvent(el, '<name>', payload)` finds it:
// RNTL's fireEvent looks up `on${Capitalized(name)}` on the fired-on
// element (or an ancestor). `injectJavaScript`, `reload` and `goBack` are
// `jest.fn()`s exposed on the ref — one persistent instance per mounted
// WebView — and ALSO on a module-level registry (`__webViews`), because a
// component test renders `<MentioraWidget />`, which owns its own ref: the
// test has no way to reach `injectJavaScript`, and every host→page message
// goes out through it.
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { ViewProps } from 'react-native';
import { View } from 'react-native';

type WebViewEvent = { nativeEvent: Record<string, unknown> };
type WebViewEventHandler = (event: WebViewEvent) => void;

// NOT wrapped in `nativeEvent`, unlike the other eight callbacks. The real
// library declares `OnShouldStartLoadWithRequest = (event: ShouldStartLoadRequest)
// => boolean` (WebViewTypes.d.ts:172) where `ShouldStartLoadRequest extends
// WebViewNavigation` (:62) — `url` and `isTopFrame` arrive at the TOP level,
// while the others are `NativeSyntheticEvent<…>` (:95-100). A mock that wraps
// this one too teaches the component to read `event.nativeEvent.url`, which is
// `undefined` in production, so `isSameOrigin(undefined, …)` denies every
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
