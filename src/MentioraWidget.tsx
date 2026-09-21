/**
 * The composition root (design.md §2.1, §2.2, §2.6; plan Task 11a).
 *
 * Everything else in this package is a module with a contract and no
 * collaborators. This is the only file where they meet, and the wiring itself
 * is the risky part:
 *
 * - `react-native-webview` has exactly ONE inbound channel and ONE outbound
 *   channel. Inbound is `onMessage` — set unconditionally, because the library
 *   only injects `window.ReactNativeWebView.postMessage` into the page when a
 *   handler is present, and without it the bridge silently does not exist.
 *   Outbound is `injectJavaScript`, which reports nothing and does nothing at
 *   all if the script does not end in `true;`.
 * - The random handshake sits INSIDE the initialize handler: the page asks to
 *   initialize, we need 16 bytes for the session key, and those bytes come back
 *   from the page over a second round trip on the same channel (§2.1). So
 *   `onMessage` hands every payload to `randomSource.acceptReply` BEFORE the
 *   JSON-RPC parser — the reply is not JSON-RPC and must never reach the peer.
 *
 * One peer and one session key per WebView (they are per page load by
 * definition); storage, the install id and the identity provider come from the
 * shared per-`embedKey` runtime (§2.4). Nothing per-load is ever put on the
 * runtime.
 *
 * Load failure, crash recovery and the handshake watchdog are Task 11b; insets
 * and the back button are Task 11c. Here, a load that fails is a load that
 * failed.
 */
import type React from 'react';
import { useCallback, useRef } from 'react';
import { Linking, StyleSheet } from 'react-native';
import type { WebViewProps } from 'react-native-webview';
import { WebView } from 'react-native-webview';
import { BridgeError, createHostPeer, type HostPeer } from './bridge/peer.js';
import { ErrorCode, PROTOCOL_VERSION } from './bridge/protocol.js';
import { isAllowedExternal, isSameOrigin } from './links.js';
import { createRandomSource, type RandomDeps, type RandomSource, toBase64Url } from './random.js';
import { getRuntime, type MentioraRuntime } from './runtime.js';
import type { MentioraWidgetProps } from './types.js';
import { SDK_NAME, SDK_VERSION } from './version.js';

/** 16 bytes, base64url — the session key the page stamps on every later message. */
const SESSION_KEY_BYTES = 16;

/**
 * Host → page framing (design.md §2.2). Two things here fail silently when
 * broken, which is why neither is inlined at the call site:
 * - the trailing `true;`, without which `injectJavaScript` is a no-op;
 * - `JSON.stringify` of the raw JSON *string*, never concatenation. `receive`
 *   takes the same string shape the page posts back to us, so the argument is
 *   stringified a second time to become a JS string literal.
 */
const injection = (raw: string): string =>
  `window.mentioraHost.receive(${JSON.stringify(raw)});true;`;

/**
 * Hands EVERY navigation to `onShouldStartLoadWithRequest`. Left at its default
 * (`http://*`, `https://*`), `react-native-webview` resolves a non-matching
 * scheme itself — `Linking.canOpenURL` then `openURL`, our handler never called
 * (`WebViewShared.tsx`, `createOnShouldStartLoadWithRequest`) — so `intent:`,
 * `file:` and friends would reach the OS without passing `isAllowedExternal`.
 * This is not the origin gate; `isSameOrigin` is, and `originWhitelist` could
 * not be it anyway, being prefix-anchored (§2.6).
 */
const ALL_ORIGINS = ['*'];

/**
 * `WebView<P = undefined>` extends `Component<WebViewProps & P>`, and
 * `WebViewProps & undefined` reduces to `never` — the library's own default
 * type argument makes every prop unassignable. `object` is the identity
 * element for that intersection and restores `WebViewProps`.
 */
type Embedded = WebView<object>;

type NavigationRequest = Parameters<NonNullable<WebViewProps['onShouldStartLoadWithRequest']>>[0];
type MessageEvent = Parameters<NonNullable<WebViewProps['onMessage']>>[0];
type OpenWindowEvent = Parameters<NonNullable<WebViewProps['onOpenWindow']>>[0];

/** Embed the widget inline. Renders no chrome: the page draws its own header. */
export function MentioraWidget(props: MentioraWidgetProps): React.JSX.Element {
  const webview = useRef<Embedded | null>(null);

  const random = useRef<RandomSource | undefined>(undefined);
  if (!random.current) {
    random.current = createRandomSource({
      inject: (script) => webview.current?.injectJavaScript(script),
      // `createRandomSource` deliberately does not sniff for an ambient global
      // (Node has had WebCrypto since v19, which would make the core suite take
      // the fast path in every test that means to exercise the inject path).
      // The composition root is the only place that knows whether a `crypto`
      // here is a real host polyfill, and in React Native it is one only if the
      // app installed it. When it is, the 2 s round trip comes out of the 8 s
      // handshake budget.
      // Cast at the seam: lib.dom / @types/node type `getRandomValues` as a
      // generic over every non-float TypedArray, which is not assignable to
      // `RandomDeps`'s deliberately narrow `(a: Uint8Array) => …`. The call is
      // the same one either way.
      ...(typeof globalThis.crypto?.getRandomValues === 'function'
        ? { globalCrypto: globalThis.crypto as RandomDeps['globalCrypto'] }
        : {}),
    });
  }
  const randomSource = random.current;

  // Called on every render, by design: `getRuntime` is keyed on `embedKey` and
  // swaps `runtime.identity` IN PLACE when a later call passes a different
  // `identity` reference (runtime.ts, last-config-wins). Everything below reads
  // `runtime.identity` live for the same reason — a local copy goes stale after
  // a reconfigure and this widget keeps calling a provider nobody is configured
  // to use.
  const runtime = getRuntime(props);

  // The peer and the navigation handlers are built once and outlive any prop
  // change, so they read the current props and runtime through this box rather
  // than closing over the first render's values.
  const latest = useRef<{ props: MentioraWidgetProps; runtime: MentioraRuntime }>({
    props,
    runtime,
  });
  latest.current = { props, runtime };

  /** The one external-link decision, shared by the `openUrl` request and by
   *  every navigation we deny. `Linking.openURL` hands straight to
   *  `UIApplication.openURL` / `Intent.ACTION_VIEW` with no validation of its
   *  own, so `isAllowedExternal` is the whole gate (§2.6). */
  const openExternal = useCallback(async (url: string): Promise<void> => {
    const { onOpenUrl, onEvent } = latest.current.props;
    if (onOpenUrl?.(url) === true) {
      onEvent?.({ type: 'openUrl', url });
      return;
    }
    if (!isAllowedExternal(url)) throw new BridgeError(ErrorCode.urlDenied, 'URL denied');
    onEvent?.({ type: 'openUrl', url });
    await Linking.openURL(url);
  }, []);

  const peerRef = useRef<HostPeer | undefined>(undefined);
  if (!peerRef.current) {
    peerRef.current = createHostPeer({
      send: (raw) => webview.current?.injectJavaScript(injection(raw)),
      handlers: {
        initialize: async () => {
          // The session key comes first and alone: it shares the single-in-flight
          // random source with the install id, so those two cannot overlap. But
          // identity never touches `randomBytes`, and serialising all three spends
          // 2 s + 2 s + BOOT_RETRY_POLICY's 4 s = exactly the 8 s the page bounds
          // the handshake by (design.md:238) — a slow identity endpoint would then
          // surface as 11b's `handshake_timeout` instead of chat. Overlapping the
          // last two gives up to 2 s of that back.
          const sessionKey = toBase64Url(await randomSource.bytes(SESSION_KEY_BYTES));
          const { runtime: live } = latest.current;
          const [installId, identityToken] = await Promise.all([
            // The runtime is shared across widgets, so it is handed THIS WebView's
            // source per call rather than owning one (runtime.ts).
            live.installId(randomSource.bytes),
            live.identity.initial(),
          ]);
          // Never `-32005`, whatever version the page asked for: we answer our
          // own, so a frozen v0 binary can still serve a future page that lists
          // v1 among its versions (design.md §2.2, Revision 1).
          return {
            protocolVersion: PROTOCOL_VERSION,
            sessionKey,
            installId,
            identityToken,
            sdk: { name: SDK_NAME, version: SDK_VERSION },
          };
        },
        refreshIdentity: async () => {
          try {
            return { identityToken: await latest.current.runtime.identity.refresh() };
          } catch {
            // EVERY rejection, not just `IdentityUnavailable`. `refresh()` has one
            // job, so any way it can fail means the same thing to the page, and
            // `-32002` is the answer design.md:238 asks for. Narrowing to the one
            // class would make a future plain `throw` inside identity.ts silently
            // downgrade to `-32603`, which the page reads as a bug on our side
            // rather than as "ask again later".
            throw new BridgeError(ErrorCode.identityUnavailable, 'Identity unavailable');
          }
        },
        openUrl: openExternal,
        onReady: () => latest.current.props.onEvent?.({ type: 'ready' }),
        onClose: () => latest.current.props.onEvent?.({ type: 'close' }),
        // `reason` only: the handler's second argument is the page's own message
        // text and MentioraEvent deliberately does not carry it (types.ts).
        onIdentityError: (reason) =>
          latest.current.props.onEvent?.({ type: 'identityError', reason }),
        // Task 11c owns the BackHandler and the release protocol.
        onBackHandling: () => {},
      },
      warn: (message) => {
        if (__DEV__) console.warn(message);
      },
    });
  }
  const peer = peerRef.current;

  const onMessage = useCallback(
    (event: MessageEvent) => {
      const raw = event.nativeEvent.data;
      // BEFORE the JSON-RPC parser, always: the random reply is not JSON-RPC and
      // would be answered `-32600` by the peer.
      if (randomSource.acceptReply(raw)) return;
      void peer.receive(raw);
    },
    [peer, randomSource],
  );

  const onShouldStartLoadWithRequest = useCallback(
    (request: NavigationRequest): boolean => {
      const { url, isTopFrame } = request;
      if (isSameOrigin(url, latest.current.props.widgetOrigin)) {
        // A load boundary is an identifiable one: initial mount (a freshly built
        // peer already IS generation 0 with no session key) and an allowed
        // TOP-FRAME navigation. Never a bare `onLoadStart` — Android raises that
        // from `doUpdateVisitedHistory`, which also sees in-page history changes,
        // so resetting there clears the session key mid-document and every later
        // message takes `-32001`. A sub-frame — the custom-block sandbox iframe —
        // is the same document and must not reset anything either (§2.2).
        if (isTopFrame) peer.resetLoad();
        return true;
      }
      // Denied here, handed to the OS. The navigation is already blocked, and a
      // link the OS will not take has nowhere to be reported: there is no
      // JSON-RPC id behind a navigation.
      void openExternal(url).catch(() => {});
      return false;
    },
    [peer, openExternal],
  );

  const onOpenWindow = useCallback(
    (event: OpenWindowEvent) => {
      void openExternal(event.nativeEvent.targetUrl).catch(() => {});
    },
    [openExternal],
  );

  return (
    <WebView<object>
      ref={webview}
      testID="mentiora-webview"
      style={styles.webview}
      // encodeURIComponent: `embedKey` is customer input and belongs in exactly
      // one path segment.
      source={{ uri: `${props.widgetOrigin}/h/rn/${encodeURIComponent(props.embedKey)}` }}
      onMessage={onMessage}
      originWhitelist={ALL_ORIGINS}
      onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
      // Its absence is CVE-2020-6506: without it a target=_blank load silently
      // replaces the top frame instead of raising `onOpenWindow` (§2.6).
      setSupportMultipleWindows={true}
      onOpenWindow={onOpenWindow}
      webviewDebuggingEnabled={__DEV__}
    />
  );
}

const styles = StyleSheet.create({
  webview: { flex: 1 },
});
