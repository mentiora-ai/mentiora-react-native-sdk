import type React from 'react';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Linking, StyleSheet, View } from 'react-native';
import type { WebViewProps } from 'react-native-webview';
import { WebView } from 'react-native-webview';
import { toBase64Url } from './base64url.js';
import {
  BridgeError,
  createHostPeer,
  type HostPeer,
  type InitializeResult,
} from './bridge/peer.js';
import { ErrorCode, PROTOCOL_VERSION } from './bridge/protocol.js';
import { BackChannelContext, ThreadChannelContext } from './channels.js';
import { IdentityUnavailable } from './identity.js';
import { hostInsetsScript, resolveHostInsets } from './insets.js';
import { isAllowedExternal, isSameDocument, isSameOrigin } from './links.js';
import { createLoadRecovery, type LoadRecovery } from './load-recovery.js';
import { createRandomSource, type RandomDeps } from './random.js';
import { getRuntime, type MentioraRuntime } from './runtime.js';
import type { MentioraErrorCode, MentioraEvent, MentioraWidgetProps } from './types.js';
import { ErrorScreen } from './ui/ErrorScreen.js';
import { SDK_NAME, SDK_VERSION } from './version.js';
import { parseWidgetUrl } from './widget-url.js';

const SESSION_KEY_BYTES = 16;

// `injectJavaScript` is a silent no-op without the trailing `true;`.
const injection = (raw: string): string =>
  `window.mentioraHost.receive(${JSON.stringify(raw)});true;`;

// Not the origin gate: with the default the library opens other schemes via
// `Linking.openURL` itself, bypassing `isAllowedExternal`.
const ALL_ORIGINS = ['*'];

// The library's default type argument collapses the props to `never`.
type Embedded = WebView<object>;

type NavigationRequest = Parameters<NonNullable<WebViewProps['onShouldStartLoadWithRequest']>>[0];
type MessageEvent = Parameters<NonNullable<WebViewProps['onMessage']>>[0];
type OpenWindowEvent = Parameters<NonNullable<WebViewProps['onOpenWindow']>>[0];
type ErrorEvent = Parameters<NonNullable<WebViewProps['onError']>>[0];

const warnedRuntimes = new WeakSet<MentioraRuntime>();

const warnEphemeralStorage = (runtime: MentioraRuntime): void => {
  if (!__DEV__ || !runtime.storage.ephemeral) return;
  const { reason, detail } = runtime.storage;
  console.warn(
    `mentiora: no persistent storage (${reason}${detail ? `: ${detail}` : ''}). ` +
      'The install id is held in memory, so every launch creates a new anonymous ' +
      'user with no thread continuity. Install ' +
      '@react-native-async-storage/async-storage, or pass `storage` on the config.',
  );
};

// `useRef` with a lazy initializer; `null` is a valid value to keep.
const useConstant = <T,>(create: () => T): T => {
  const ref = useRef<{ value: T } | null>(null);
  if (ref.current === null) ref.current = { value: create() };
  return ref.current.value;
};

// iOS `inactive` (Control Center, app switcher) is brief; hiding on it would flap.
const useBackgrounded = (): boolean => {
  const [backgrounded, setBackgrounded] = useState(AppState.currentState === 'background');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setBackgrounded(state === 'background');
    });
    return () => subscription.remove();
  }, []);
  return backgrounded;
};

/** Embeds the widget inline. Renders no chrome: the page draws its own header. */
export function MentioraWidget(props: MentioraWidgetProps): React.JSX.Element {
  const webview = useRef<Embedded | null>(null);
  const visible = props.visible ?? true;
  const backgrounded = useBackgrounded();
  // `getRuntime` swaps `runtime.identity` in place on reconfigure; read it live.
  const runtime = getRuntime(props);
  const threadChannel = useContext(ThreadChannelContext);
  const registerBackPress = useContext(BackChannelContext);

  const [errorCode, setErrorCode] = useState<MentioraErrorCode | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [remountKey, setRemountKey] = useState(0);

  // The peer, the recovery ladders and the navigation handlers are built once and read
  // current values here.
  const snapshot = {
    props,
    runtime,
    backgrounded,
    threadChannel,
    ended: errorCode !== null || dismissed,
  };
  const latest = useRef(snapshot);
  latest.current = snapshot;

  const emit = (event: MentioraEvent): void => latest.current.props.onEvent?.(event);
  const emitSafely = (event: MentioraEvent): void => {
    try {
      emit(event);
    } catch {
      // A throwing host callback must not break the SDK path that raised the event.
    }
  };

  // Not trusted alone: see `onHardwareBack`.
  const backHeld = useRef(false);
  // Set by `ready`, from which the document accepts `mentiora/open`.
  const pageReady = useRef(false);
  const lastTopUrl = useRef<string | null>(null);

  const randomSource = useConstant(() =>
    createRandomSource({
      inject: (script) => webview.current?.injectJavaScript(script),
      // Without it, bytes cost a page round trip of up to 2s of the 8s handshake budget.
      ...(typeof globalThis.crypto?.getRandomValues === 'function'
        ? { globalCrypto: globalThis.crypto as RandomDeps['globalCrypto'] }
        : {}),
    }),
  );

  const recovery: LoadRecovery = useConstant(() =>
    createLoadRecovery({
      reload: () => webview.current?.reload(),
      remount: () => setRemountKey((k) => k + 1),
      onLoadBoundary: () => {
        peer.resetLoad();
        pageReady.current = false;
        backHeld.current = false;
        // A pending `bytes()` from the dead document would block the next `initialize` for 2s.
        randomSource.reset();
      },
      onGiveUp: (code) => {
        setErrorCode(code);
        emit({ type: 'error', code });
      },
      hasSession: () => peer.sessionKey() !== null,
    }),
  );

  // `Linking.openURL` validates nothing; `isAllowedExternal` is the whole gate.
  const openExternal = useCallback(async (url: string): Promise<void> => {
    const { onOpenUrl } = latest.current.props;
    if (onOpenUrl?.(url) === true) {
      latest.current.props.onEvent?.({ type: 'openUrl', url });
      return;
    }
    if (!isAllowedExternal(url)) throw new BridgeError(ErrorCode.urlDenied, 'URL denied');
    latest.current.props.onEvent?.({ type: 'openUrl', url });
    await Linking.openURL(url);
  }, []);

  const buildInitializeResult = async (gen: number): Promise<InitializeResult> => {
    // Serialising all three spends the page's whole 8s budget.
    const sessionKey = toBase64Url(await randomSource.bytes(SESSION_KEY_BYTES));
    const { runtime: live } = latest.current;
    const [installId, identityToken] = await Promise.all([
      live.installId(randomSource.bytes),
      live.identity.initial(),
    ]);
    recovery.handshakeSucceeded(gen);
    // Taken last, so a tap landing during the awaits above still rides along.
    const threadId = latest.current.threadChannel?.take() ?? null;
    // Never `-32005`: an old binary can still serve a page listing a newer version.
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionKey,
      installId,
      identityToken,
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      // Read after the awaits: a `show`/`hide` sent during them is dropped, since the
      // peer assigns the session key only once this resolves.
      visible: (latest.current.props.visible ?? true) && !latest.current.backgrounded,
      ...(threadId !== null ? { threadId } : {}),
    };
  };

  // Its own code, so the page shows "sign in again", not "Update needed".
  const toHandshakeError = (e: unknown): unknown => {
    if (!(e instanceof IdentityUnavailable)) return e;
    if (__DEV__) {
      console.warn(
        `mentiora identity: ${e.message}. The handshake will fail until an ` +
          '`identity` is configured for this embed key, or `Mentiora.logout()` ' +
          'is called to release the signed-in marker.',
      );
    }
    // A throwing host callback must not turn this into a -32603 for the page.
    emitSafely({ type: 'identityError', reason: 'identity_required' });
    return new BridgeError(ErrorCode.identityUnavailable, 'Identity unavailable');
  };

  const peer: HostPeer = useConstant(() =>
    createHostPeer({
      send: (raw) => webview.current?.injectJavaScript(injection(raw)),
      handlers: {
        initialize: async () => {
          recovery.handshakeStarted();
          const gen = recovery.generation();
          try {
            return await buildInitializeResult(gen);
          } catch (e) {
            recovery.handshakeFailed(gen);
            throw toHandshakeError(e);
          }
        },
        refreshIdentity: async () => {
          try {
            return { identityToken: await latest.current.runtime.identity.refresh() };
          } catch {
            // Otherwise it surfaces as `-32603`.
            throw new BridgeError(ErrorCode.identityUnavailable, 'Identity unavailable');
          }
        },
        openUrl: openExternal,
        onReady: () => {
          recovery.ready();
          pageReady.current = true;
          const threadId = latest.current.threadChannel?.take() ?? null;
          if (threadId !== null) peer.sendOpen(threadId);
          emit({ type: 'ready' });
        },
        onClose: () => emit({ type: 'close' }),
        onIdentityError: (reason) => emit({ type: 'identityError', reason }),
        onBackHandling: (active) => {
          backHeld.current = active;
        },
        onUnreadCountChanged: (count) => emit({ type: 'unreadCountChanged', count }),
      },
      warn: (message) => {
        if (__DEV__) console.warn(message);
      },
    }),
  );

  // Always a remount: Android cannot reuse a killed renderer.
  const restart = useCallback((): void => {
    recovery.restart();
    setDismissed(false);
    setErrorCode(null);
  }, [recovery]);

  // Needs the full restart: without a load boundary the new page's `initialize`
  // gets `-32600` and a stale `backHeld` claims its back presses.
  useEffect(() => runtime.onReload(restart), [runtime, restart]);

  // The page keeps the credential it booted with; only a new document re-runs `initialize`.
  const bootIdentity = useRef(props.identity);
  const identityChangedAt = useRef(0);
  useEffect(() => {
    if (bootIdentity.current === props.identity) return;
    bootIdentity.current = props.identity;
    const now = Date.now();
    if (__DEV__ && now - identityChangedAt.current < 1000) {
      console.warn(
        'mentiora: `identity` changed twice within a second, and every change reloads the ' +
          'page. It is compared by reference: define it outside render or memoize it.',
      );
    }
    identityChangedAt.current = now;
    restart();
  }, [props.identity, restart]);

  // A non-ready document takes the thread in `initialize`/`ready`; an ended one is
  // restarted by the following `show` and takes it in the handshake.
  useEffect(() => {
    if (threadChannel === null) return;
    return threadChannel.subscribe(() => {
      if (!pageReady.current || peer.sessionKey() === null) return;
      if (latest.current.ended) return;
      const threadId = threadChannel.take();
      if (threadId !== null) peer.sendOpen(threadId);
    });
  }, [threadChannel, peer]);

  // Inside `<MentioraHost />` the presenter forwards it, mounted or not.
  useEffect(() => {
    if (threadChannel !== null) return;
    return runtime.onInstallRefChange((installRef) => {
      latest.current.props.onEvent?.({ type: 'installRefChanged', installRef });
    });
  }, [runtime, threadChannel]);

  useEffect(() => {
    if (!runtime.storage.ephemeral || warnedRuntimes.has(runtime)) return;
    warnedRuntimes.add(runtime);
    warnEphemeralStorage(runtime);
    latest.current.props.onEvent?.({ type: 'storageUnavailable', reason: runtime.storage.reason });
  }, [runtime]);

  // Not in render: a discarded render would leave a live timer.
  useEffect(() => {
    recovery.start();
    return () => {
      recovery.dispose();
      // Its 2s timeout would outlive the widget.
      randomSource.reset();
    };
  }, [recovery, randomSource]);

  const onDismiss = (): void => {
    setDismissed(true);
    // A throwing host callback must not undo the dismiss.
    emitSafely({ type: 'close' });
  };

  const hostInsets = useConstant(() => resolveHostInsets());
  const injectHostInsets = useCallback((): void => {
    if (hostInsets) webview.current?.injectJavaScript(hostInsetsScript(hostInsets));
  }, [hostInsets]);

  // `webview` attaches after commit, and the first `onLoadEnd` may be late.
  useEffect(() => {
    injectHostInsets();
  }, [injectHostInsets]);

  // No `resetLoad()` here: the warm page keeps its session key (else `-32001`). No
  // watchdog either: no second `initialize` is coming, so it would fire and reload.
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (wasVisible.current === visible) return;
    wasVisible.current = visible;
    if (!visible) {
      backHeld.current = false;
      // Back and `close()` bypass the page's own close button, so it must be told.
      peer.sendHide();
      return;
    }
    if (errorCode !== null || dismissed) {
      restart();
      return;
    }
    // Insets are pushed on `onLoadEnd`, and a warm show has none.
    injectHostInsets();
    // The return from background sends it.
    if (!latest.current.backgrounded) peer.sendShow();
  }, [visible, errorCode, dismissed, injectHostInsets, peer, restart]);

  // A backgrounded panel would keep acking reads, suppressing the missed-message webhook.
  const wasBackgrounded = useRef(backgrounded);
  useEffect(() => {
    if (wasBackgrounded.current === backgrounded) return;
    wasBackgrounded.current = backgrounded;
    if (!visible || errorCode !== null || dismissed) return;
    if (backgrounded) peer.sendHide();
    else peer.sendShow();
  }, [backgrounded, visible, errorCode, dismissed, peer]);

  // Only a non-null `peer.sessionKey()` at press time proves `backHeld` survived
  // a reload. `dismissed`/`errorCode` first: giving up crosses no load boundary.
  const onHardwareBack = useCallback((): boolean => {
    if (!visible || dismissed || errorCode !== null) return false;
    if (!backHeld.current || peer.sessionKey() === null) return false;
    peer.sendBack();
    return true;
  }, [peer, dismissed, errorCode, visible]);

  // Layout effect: passive effects flush a task after a timer's `onGiveUp`, and a press
  // in that gap would run the stale closure.
  useLayoutEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', onHardwareBack);
    registerBackPress?.(onHardwareBack);
    // `BackHandler.removeEventListener` was removed in RN 0.77 and throws.
    return () => {
      subscription.remove();
      registerBackPress?.(null);
    };
  }, [onHardwareBack, registerBackPress]);

  const onMessage = useCallback(
    (event: MessageEvent) => {
      const raw = event.nativeEvent.data;
      // Before the peer: the random reply is not JSON-RPC and would get `-32600`.
      if (randomSource.acceptReply(raw)) return;
      void peer.receive(raw);
    },
    [peer, randomSource],
  );

  const widgetPage = parseWidgetUrl(props.widgetUrl);

  const onShouldStartLoadWithRequest = (request: NavigationRequest): boolean => {
    const { url, isTopFrame, navigationType } = request;
    if (isSameOrigin(url, widgetPage.origin)) {
      // Not `onLoadStart`: Android raises it on history updates, killing the session key.
      if (isTopFrame) {
        const previous = lastTopUrl.current;
        lastTopUrl.current = url;
        if (previous === null || navigationType === 'reload' || !isSameDocument(previous, url))
          recovery.navigated();
      }
      return true;
    }
    // No JSON-RPC id to report a denial on.
    void openExternal(url).catch(() => {});
    return false;
  };

  const onOpenWindow = useCallback(
    (event: OpenWindowEvent) => {
      void openExternal(event.nativeEvent.targetUrl).catch(() => {});
    },
    [openExternal],
  );

  const onError = (event: ErrorEvent): void => {
    event.preventDefault?.();
    recovery.loadFailed();
  };

  // First, so Dismiss wins over an error a stray timer sets afterwards.
  if (dismissed) return <View />;

  return (
    <View style={styles.container}>
      <WebView<object>
        key={remountKey}
        ref={webview}
        testID="mentiora-webview"
        style={styles.webview}
        // Fixed per instance: Android raises no `onShouldStartLoadWithRequest` for a `source` change.
        source={{ uri: widgetPage.url }}
        onMessage={onMessage}
        originWhitelist={ALL_ORIGINS}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        // CVE-2020-6506: without it a target=_blank load replaces the top frame.
        setSupportMultipleWindows={true}
        onOpenWindow={onOpenWindow}
        webviewDebuggingEnabled={__DEV__}
        onError={onError}
        onContentProcessDidTerminate={recovery.processTerminated}
        onRenderProcessGone={recovery.renderProcessGone}
        onLoadEnd={() => {
          recovery.loadEnded();
          injectHostInsets();
        }}
        importantForAccessibility={errorCode !== null ? 'no-hide-descendants' : 'auto'}
      />
      {/* The WebView stays mounted underneath so a running ladder can still reload it. */}
      {errorCode !== null && (
        // iOS counterpart of `importantForAccessibility` above.
        <View style={StyleSheet.absoluteFill} accessibilityViewIsModal={true}>
          {props.renderError ? (
            props.renderError({ code: errorCode, retry: restart, dismiss: onDismiss })
          ) : (
            <ErrorScreen
              strings={props.strings}
              code={errorCode}
              onRetry={restart}
              onDismiss={onDismiss}
            />
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },
});
