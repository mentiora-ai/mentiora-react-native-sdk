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
// WebView — so a test's own ref sees every call for assertion.
import { forwardRef, useImperativeHandle, useRef } from 'react';
import type { ViewProps } from 'react-native';
import { View } from 'react-native';

type WebViewEvent = { nativeEvent: Record<string, unknown> };
type WebViewEventHandler = (event: WebViewEvent) => void;

export type MockWebViewProps = ViewProps & {
  source?: unknown;
  onMessage?: WebViewEventHandler;
  onError?: WebViewEventHandler;
  onHttpError?: WebViewEventHandler;
  onLoadStart?: WebViewEventHandler;
  onLoadEnd?: WebViewEventHandler;
  onShouldStartLoadWithRequest?: (event: WebViewEvent) => boolean | undefined;
  onOpenWindow?: WebViewEventHandler;
  onRenderProcessGone?: WebViewEventHandler;
  onContentProcessDidTerminate?: WebViewEventHandler;
};

export type MockWebViewRef = {
  injectJavaScript: (script: string) => void;
  reload: () => void;
  goBack: () => void;
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

  const { source: _source, ...viewProps } = props;

  return <View {...viewProps} />;
});

WebView.displayName = 'WebView';

export default WebView;
