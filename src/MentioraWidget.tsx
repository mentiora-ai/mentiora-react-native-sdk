/**
 * Three timers can be live per page load: the network ladder, the crash ladder
 * and the handshake watchdog. Each is tagged with the `generation` it was armed
 * under and no-ops if that moved. `handled` lets one incident advance only one
 * counter.
 */
import type React from 'react';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BackHandler, Linking, Platform, StatusBar, StyleSheet, View } from 'react-native';
import type { WebViewProps } from 'react-native-webview';
import { WebView } from 'react-native-webview';
import { BackChannelContext } from './back-channel.js';
import { BridgeError, createHostPeer, type HostPeer } from './bridge/peer.js';
import { ErrorCode, PROTOCOL_VERSION } from './bridge/protocol.js';
import { IdentityUnavailable } from './identity.js';
import { isAllowedExternal, isSameDocument, isSameOrigin } from './links.js';
import { createRandomSource, type RandomDeps, type RandomSource, toBase64Url } from './random.js';
import { delaysFor, type RetryPolicy } from './retry.js';
import { getRuntime, type MentioraRuntime } from './runtime.js';
import type { MentioraErrorCode, MentioraWidgetProps } from './types.js';
import { ErrorScreen } from './ui/ErrorScreen.js';
import { SDK_NAME, SDK_VERSION } from './version.js';

const SESSION_KEY_BYTES = 16;

// `injectJavaScript` is a silent no-op without the trailing `true;`. The raw
// JSON is `JSON.stringify`d into a string literal, never concatenated.
const injection = (raw: string): string =>
  `window.mentioraHost.receive(${JSON.stringify(raw)});true;`;

// WebView `env(safe-area-inset-*)` is empty before Android M136, so the page
// also reads `--mw-host-inset-*`.
type HostInsets = { top: number; right: number; bottom: number; left: number };

// A non-finite field becomes `"undefinedpx"`, which makes the page's
// `max(env(...), var(...))` drop the whole padding declaration.
const hasValidInsets = (insets: HostInsets): boolean =>
  Number.isFinite(insets.top) &&
  Number.isFinite(insets.right) &&
  Number.isFinite(insets.bottom) &&
  Number.isFinite(insets.left);

// A bare `require` in the ESM build throws a `ReferenceError` the catch below
// would misreport as "peer not installed", hence the `typeof` check first.
const loadSafeAreaInsets = (
  hasRequire: () => boolean = () => typeof require === 'function',
  requireModule: () => unknown = () => require('react-native-safe-area-context'),
): HostInsets | null => {
  if (!hasRequire()) return null;
  try {
    const mod = requireModule() as { initialWindowMetrics?: { insets: HostInsets } | null };
    const insets = mod.initialWindowMetrics?.insets;
    return insets && hasValidInsets(insets) ? insets : null;
  } catch {
    return null; // peer not installed
  }
};

/** Test-only. */
export const __loadSafeAreaInsetsForTest = loadSafeAreaInsets;

const resolveHostInsets = (
  load: () => HostInsets | null = loadSafeAreaInsets,
): HostInsets | null => {
  const measured = load();
  if (measured) return measured;
  if (Platform.OS === 'android')
    return { top: StatusBar.currentHeight ?? 0, right: 0, bottom: 0, left: 0 };
  return null;
};

/** Test-only. */
export const __resolveHostInsetsForTest = resolveHostInsets;

/** Test-only. */
export const __hasValidInsetsForTest = hasValidInsets;

// Same invariants as `injection`: every value through `JSON.stringify`, ends in `true;`.
const hostInsetsScript = (insets: HostInsets): string => {
  const set = (name: string, px: number): string =>
    `document.documentElement.style.setProperty(${JSON.stringify(name)}, ${JSON.stringify(`${px}px`)});`;
  return (
    set('--mw-host-inset-top', insets.top) +
    set('--mw-host-inset-right', insets.right) +
    set('--mw-host-inset-bottom', insets.bottom) +
    set('--mw-host-inset-left', insets.left) +
    'true;'
  );
};

// Routes every navigation through `onShouldStartLoadWithRequest`. With the
// default, the library opens other schemes via `Linking.openURL` itself,
// bypassing `isAllowedExternal`. This is not the origin gate.
const ALL_ORIGINS = ['*'];

// The library's default type argument yields `WebViewProps & undefined`, i.e.
// `never`, making every prop unassignable.
type Embedded = WebView<object>;

type NavigationRequest = Parameters<NonNullable<WebViewProps['onShouldStartLoadWithRequest']>>[0];
type MessageEvent = Parameters<NonNullable<WebViewProps['onMessage']>>[0];
type OpenWindowEvent = Parameters<NonNullable<WebViewProps['onOpenWindow']>>[0];
type ErrorEvent = Parameters<NonNullable<WebViewProps['onError']>>[0];
type TerminatedEvent = Parameters<NonNullable<WebViewProps['onContentProcessDidTerminate']>>[0];
type RenderProcessGoneEvent = Parameters<NonNullable<WebViewProps['onRenderProcessGone']>>[0];
type LoadEndEvent = Parameters<NonNullable<WebViewProps['onLoadEnd']>>[0];

const LOAD_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  baseMs: 1000,
  capMs: 8000,
  totalBudgetMs: 8000,
};

// 3 automatic recoveries plus the incident that gives up.
const CRASH_RETRY_POLICY: RetryPolicy = {
  attempts: 4,
  baseMs: 1000,
  capMs: 8000,
  totalBudgetMs: 8000,
};

const HANDSHAKE_WATCHDOG_MS = 8000;
const HANDSHAKE_RECOVERY_CAP = 1;

// `getRuntime` memoises per embed key, so this warns once per embed key.
const warnedRuntimes = new WeakSet<MentioraRuntime>();

/** Embeds the widget inline. Renders no chrome: the page draws its own header. */
export function MentioraWidget(props: MentioraWidgetProps): React.JSX.Element {
  const webview = useRef<Embedded | null>(null);
  const visible = props.visible ?? true;

  const random = useRef<RandomSource | undefined>(undefined);
  if (!random.current) {
    random.current = createRandomSource({
      inject: (script) => webview.current?.injectJavaScript(script),
      // Without a host `crypto`, bytes come from a page round trip costing up
      // to 2s of the 8s handshake budget.
      ...(typeof globalThis.crypto?.getRandomValues === 'function'
        ? { globalCrypto: globalThis.crypto as RandomDeps['globalCrypto'] }
        : {}),
    });
  }
  const randomSource = random.current;

  // Called every render: `getRuntime` swaps `runtime.identity` in place on
  // reconfigure, so callers must read it live.
  const runtime = getRuntime(props);

  // The peer and navigation handlers are built once and read current props here.
  const latest = useRef<{ props: MentioraWidgetProps; runtime: MentioraRuntime }>({
    props,
    runtime,
  });
  latest.current = { props, runtime };

  // `Linking.openURL` validates nothing, so `isAllowedExternal` is the whole gate.
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

  // Not trusted alone: see `onHardwareBack`.
  const backHeld = useRef(false);

  // Last top-frame URL, to tell a fragment-only navigation from a real one.
  const lastTopUrl = useRef<string | null>(null);

  // Non-null only inside `<MentioraHost />`'s Modal; inline uses `BackHandler` alone.
  const registerBackPress = useContext(BackChannelContext);

  const peerRef = useRef<HostPeer | undefined>(undefined);
  if (!peerRef.current) {
    peerRef.current = createHostPeer({
      send: (raw) => webview.current?.injectJavaScript(injection(raw)),
      handlers: {
        initialize: async () => {
          // Before any `await`: an `initialize` at 7.9s must disarm the 8s watchdog.
          clearWatchdogTimer();
          handshakeDone.current = true;
          const myGen = generation.current;
          try {
            // The random source allows one request in flight; serialising all
            // three spends the page's whole 8s budget.
            const sessionKey = toBase64Url(await randomSource.bytes(SESSION_KEY_BYTES));
            const { runtime: live } = latest.current;
            const [installId, identityToken] = await Promise.all([
              live.installId(randomSource.bytes),
              live.identity.initial(),
            ]);
            // Success path only: resetting before a rejection makes the catch
            // below an unbounded reload loop. `crashFailures` never resets: a
            // react-native-webview#1767 crasher boots fine and dies later.
            if (generation.current === myGen) {
              networkFailures.current = 0;
              handshakeTimeouts.current = 0;
            }
            // Always our own version, never `-32005`: an old binary can still
            // serve a page that lists a newer version.
            return {
              protocolVersion: PROTOCOL_VERSION,
              sessionKey,
              installId,
              identityToken,
              sdk: { name: SDK_NAME, version: SDK_VERSION },
            };
          } catch (e) {
            // Re-arm: `onLoadEnd` will not fire again, so without this a
            // rejected handshake leaves the widget dead with no error surface.
            if (__DEV__ && e instanceof IdentityUnavailable) {
              console.warn(
                `mentiora identity: ${e.message}. The handshake will fail until an ` +
                  '`identity` is configured for this embed key, or `Mentiora.logout()` ' +
                  'is called to release the signed-in marker.',
              );
            }
            if (generation.current === myGen) armWatchdog();
            throw e;
          }
        },
        refreshIdentity: async () => {
          try {
            return { identityToken: await latest.current.runtime.identity.refresh() };
          } catch {
            // Every rejection maps here; otherwise it surfaces as `-32603`.
            throw new BridgeError(ErrorCode.identityUnavailable, 'Identity unavailable');
          }
        },
        openUrl: openExternal,
        onReady: () => latest.current.props.onEvent?.({ type: 'ready' }),
        onClose: () => latest.current.props.onEvent?.({ type: 'close' }),
        // The page's message text is not forwarded.
        onIdentityError: (reason) =>
          latest.current.props.onEvent?.({ type: 'identityError', reason }),
        onBackHandling: (active) => {
          backHeld.current = active;
        },
      },
      warn: (message) => {
        if (__DEV__) console.warn(message);
      },
    });
  }
  const peer = peerRef.current;

  // Counters are refs so a scheduled timer reads current values.
  const [errorCode, setErrorCode] = useState<MentioraErrorCode | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [remountKey, setRemountKey] = useState(0);

  // Logout needs the full `restartLoad`: without a load boundary the new page's
  // `initialize` gets `-32600` and a stale `backHeld` claims its back presses.
  useEffect(() => {
    return runtime.onReload(() => restart.current());
  }, [runtime]);

  // Warn and emit an event: `__DEV__` is stripped from release bundles.
  useEffect(() => {
    if (!runtime.storage.ephemeral || warnedRuntimes.has(runtime)) return;
    warnedRuntimes.add(runtime);
    const { reason, detail } = runtime.storage;
    if (__DEV__)
      console.warn(
        `mentiora: no persistent storage (${reason}${detail ? `: ${detail}` : ''}). ` +
          'The install id is held in memory, so every launch creates a new anonymous ' +
          'user with no thread continuity. Install ' +
          '@react-native-async-storage/async-storage, or pass `storage` on the config.',
      );
    latest.current.props.onEvent?.({ type: 'storageUnavailable', reason });
  }, [runtime]);
  // Assigned during render below; effects run after commit, so the placeholder is never called.
  const restart = useRef<() => void>(() => {});

  const generation = useRef(0);
  // One incident can raise two callbacks; only the first advances a counter.
  const handled = useRef(false);
  const networkFailures = useRef(0);
  const crashFailures = useRef(0);
  const handshakeTimeouts = useRef(0);
  // Whether THIS document has handshaked. Cleared by `advanceGeneration`, which every
  // load we trigger goes through. Not `onLoadStart`: Android raises that on in-page
  // history changes too, and clearing there would re-arm on an SPA navigation.
  const handshakeDone = useRef(false);
  const watchdogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearWatchdogTimer = (): void => {
    if (watchdogTimer.current !== null) {
      clearTimeout(watchdogTimer.current);
      watchdogTimer.current = null;
    }
  };
  const clearRecoveryTimer = (): void => {
    if (recoveryTimer.current !== null) {
      clearTimeout(recoveryTimer.current);
      recoveryTimer.current = null;
    }
  };

  const onTerminal = (fn: () => void): void => {
    if (handled.current) return;
    handled.current = true;
    fn();
  };

  const showError = (code: MentioraErrorCode): void => {
    setErrorCode(code);
    latest.current.props.onEvent?.({ type: 'error', code });
  };

  // Cancels running timers; arms no new watchdog.
  const advanceGeneration = (): void => {
    peer.resetLoad();
    handshakeDone.current = false;
    backHeld.current = false;
    // A pending `bytes()` from the dead document would hold the one in-flight
    // slot for 2s and reject the next `initialize`.
    randomSource.reset();
    generation.current += 1;
    handled.current = false;
    clearRecoveryTimer();
    clearWatchdogTimer();
  };

  const armWatchdog = (): void => {
    clearWatchdogTimer();
    const gen = generation.current;
    watchdogTimer.current = setTimeout(() => {
      watchdogTimer.current = null;
      if (generation.current !== gen) return;
      onTerminal(() => {
        handshakeTimeouts.current += 1;
        if (handshakeTimeouts.current <= HANDSHAKE_RECOVERY_CAP) {
          beginFreshLoad();
          webview.current?.reload();
        } else {
          showError('handshake_timeout');
        }
      });
    }, HANDSHAKE_WATCHDOG_MS);
  };

  const beginFreshLoad = (): void => {
    advanceGeneration();
    armWatchdog();
  };

  const scheduleRecovery = (delayMs: number, action: () => void): void => {
    clearRecoveryTimer();
    const gen = generation.current;
    recoveryTimer.current = setTimeout(() => {
      recoveryTimer.current = null;
      if (generation.current !== gen) return;
      advanceGeneration();
      action();
    }, delayMs);
  };

  // Not in the render body: a discarded render would leave a live timer and a
  // spurious `handshake_timeout`. The null-key guard stops an Offscreen re-show re-arming.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; `peer` and `armWatchdog` read refs that are stable for this instance
  useEffect(() => {
    if (peer.sessionKey() === null) armWatchdog();
    return () => {
      if (watchdogTimer.current !== null) clearTimeout(watchdogTimer.current);
      if (recoveryTimer.current !== null) clearTimeout(recoveryTimer.current);
      // An `initialize` rejecting after unmount must not re-arm the watchdog.
      generation.current += 1;
    };
  }, []);

  /**
   * The watchdog guards a document until its handshake, so a document that already
   * handshaked must not re-arm one. The page can answer `initialize` before the native
   * load-end event arrives, and arming unconditionally then starts a timer nothing will
   * ever clear — this load's `initialize` is spent — which silently reloads a working
   * widget one budget later. Keyed on the flag rather than `peer.sessionKey()`: that
   * survives until the next `resetLoad`, so a ladder reload after a good handshake would
   * leave the new document unguarded.
   */
  const onLoadEnd = (_event: LoadEndEvent): void => {
    if (!handshakeDone.current) armWatchdog();
  };

  const onError = (event: ErrorEvent): void => {
    event.preventDefault?.();
    onTerminal(() => {
      networkFailures.current += 1;
      if (networkFailures.current < LOAD_RETRY_POLICY.attempts) {
        const delay = delaysFor(LOAD_RETRY_POLICY)[networkFailures.current - 1] ?? 0;
        scheduleRecovery(delay, () => webview.current?.reload());
      } else {
        showError('load_failed');
      }
    });
  };

  // Android cannot reuse a killed renderer, so it remounts instead of `reload()`.
  const recoverFromCrash = (recover: () => void): void => {
    onTerminal(() => {
      crashFailures.current += 1;
      if (crashFailures.current < CRASH_RETRY_POLICY.attempts) {
        const delay = delaysFor(CRASH_RETRY_POLICY)[crashFailures.current - 1] ?? 0;
        scheduleRecovery(delay, recover);
      } else {
        showError('renderer_crashed');
      }
    });
  };

  const onContentProcessDidTerminate = (_event: TerminatedEvent): void => {
    recoverFromCrash(() => webview.current?.reload());
  };

  const onRenderProcessGone = (_event: RenderProcessGoneEvent): void => {
    recoverFromCrash(() => setRemountKey((k) => k + 1));
  };

  // Retry and logout. Always a remount, since Android cannot reuse a killed renderer.
  const restartLoad = (): void => {
    networkFailures.current = 0;
    crashFailures.current = 0;
    handshakeTimeouts.current = 0;
    beginFreshLoad();
    setDismissed(false);
    setRemountKey((k) => k + 1);
    setErrorCode(null);
  };
  restart.current = restartLoad;

  // Plain state so it still works when everything else has failed.
  const onDismiss = (): void => {
    setDismissed(true);
    try {
      latest.current.props.onEvent?.({ type: 'close' });
    } catch {
      // A throwing host callback must not undo the dismiss.
    }
  };

  // `null` is a valid memoized answer, hence the separate guard ref.
  const hostInsetsComputed = useRef(false);
  const hostInsets = useRef<HostInsets | null>(null);
  if (!hostInsetsComputed.current) {
    hostInsetsComputed.current = true;
    hostInsets.current = resolveHostInsets();
  }

  // Stable identity keeps the effect below mount-only.
  const injectHostInsets = useCallback((): void => {
    const insets = hostInsets.current;
    if (insets) webview.current?.injectJavaScript(hostInsetsScript(insets));
  }, []);

  // `webview` attaches after commit, and the first `onLoadEnd` may be late.
  useEffect(() => {
    injectHostInsets();
  }, [injectHostInsets]);

  /**
   * The show/hide transition. Kept warm, the document survives a close, so the state
   * that used to die with the unmount has to be handled explicitly.
   *
   * There is deliberately no `advanceGeneration()`/`peer.resetLoad()` here: the live
   * page keeps sending under its session key, and clearing it would answer every
   * message `-32001`. Nor is a watchdog armed — no second `initialize` is coming for a
   * document that already handshaked, so one would fire and silently reload.
   */
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (wasVisible.current === visible) return;
    wasVisible.current = visible;
    if (!visible) {
      // Whatever route the page had open belongs to a screen nobody is looking at.
      backHeld.current = false;
      return;
    }
    // A session that ended on the error screen or a dismissal has no usable document
    // behind it, so reopening has to start a fresh load rather than reveal the corpse.
    if (errorCode !== null || dismissed) {
      restart.current();
      return;
    }
    // Insets are pushed on `onLoadEnd`, and a warm show has none.
    injectHostInsets();
    // The page's launch signal is once-per-document, so a reused document needs telling.
    peer.sendShow();
  }, [visible, errorCode, dismissed, injectHostInsets, peer]);

  // Only a non-null `peer.sessionKey()` at press time proves `backHeld` survived
  // a reload. `dismissed`/`errorCode` first: giving up crosses no load boundary.
  const onHardwareBack = useCallback((): boolean => {
    // Parked: mounted no longer implies on screen, so the press belongs to the host app.
    if (!visible) return false;
    if (dismissed || errorCode !== null) return false;
    if (backHeld.current && peer.sessionKey() !== null) {
      peer.sendBack();
      return true;
    }
    return false;
  }, [peer, dismissed, errorCode, visible]);

  // Layout effect: after `showError` from a timer, passive effects flush a task
  // later, and a press in that gap would run the stale closure.
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

  const onShouldStartLoadWithRequest = (request: NavigationRequest): boolean => {
    const { url, isTopFrame, navigationType } = request;
    if (isSameOrigin(url, latest.current.props.widgetOrigin)) {
      // Not `onLoadStart`: Android raises it from `doUpdateVisitedHistory`, so
      // resetting there kills the session key mid-document (`-32001`).
      if (isTopFrame) {
        const previous = lastTopUrl.current;
        lastTopUrl.current = url;
        if (previous === null || navigationType === 'reload' || !isSameDocument(previous, url))
          beginFreshLoad();
      }
      return true;
    }
    // No JSON-RPC id to report a denial on, so errors are dropped.
    void openExternal(url).catch(() => {});
    return false;
  };

  const onOpenWindow = useCallback(
    (event: OpenWindowEvent) => {
      void openExternal(event.nativeEvent.targetUrl).catch(() => {});
    },
    [openExternal],
  );

  // First, so Dismiss wins over an error a stray timer sets afterwards.
  if (dismissed) return <View />;

  return (
    <View style={styles.container}>
      <WebView<object>
        key={remountKey}
        ref={webview}
        testID="mentiora-webview"
        style={styles.webview}
        // Fixed per instance: Android does not raise `onShouldStartLoadWithRequest`
        // for a `source` change, so `key` the component to change either prop.
        source={{ uri: `${props.widgetOrigin}/h/rn/${encodeURIComponent(props.embedKey)}` }}
        onMessage={onMessage}
        originWhitelist={ALL_ORIGINS}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        // CVE-2020-6506: without it a target=_blank load replaces the top frame.
        setSupportMultipleWindows={true}
        onOpenWindow={onOpenWindow}
        webviewDebuggingEnabled={__DEV__}
        onError={onError}
        onContentProcessDidTerminate={onContentProcessDidTerminate}
        onRenderProcessGone={onRenderProcessGone}
        onLoadEnd={(event) => {
          onLoadEnd(event);
          injectHostInsets();
        }}
        // Hides the dead page under the overlay from TalkBack.
        importantForAccessibility={errorCode !== null ? 'no-hide-descendants' : 'auto'}
      />
      {/* The WebView stays mounted underneath so a running ladder can still reload it. */}
      {errorCode !== null && (
        // iOS counterpart of `importantForAccessibility` above.
        <View style={StyleSheet.absoluteFill} accessibilityViewIsModal={true}>
          <ErrorScreen
            strings={props.strings}
            code={errorCode}
            onRetry={restartLoad}
            onDismiss={onDismiss}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },
});
