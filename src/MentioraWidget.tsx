/**
 * The composition root: the only file where the modules meet.
 * Three timers can be live for one page load — the network ladder, the crash
 * ladder and the handshake watchdog. Each is tagged with the `generation` it
 * was armed under and is a no-op if that moved; `handled` gates all three so
 * one incident advances exactly one counter; the watchdog is armed from
 * `onLoadEnd`, never from a ladder's own reload.
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

/** 16 bytes, base64url — the session key the page stamps on every later message. */
const SESSION_KEY_BYTES = 16;

/** Host -> page framing. Both invariants fail silently: `injectJavaScript` is a
 *  no-op without the trailing `true;`, and the raw JSON is re-`JSON.stringify`d
 *  into a JS string literal, never concatenated. */
const injection = (raw: string): string =>
  `window.mentioraHost.receive(${JSON.stringify(raw)});true;`;

/** `--mw-host-inset-*` is set only when measurable: `initialWindowMetrics`
 *  from `react-native-safe-area-context` (no `<SafeAreaProvider>` needed), else
 *  `StatusBar.currentHeight`, WebView `env()` being empty before Android M136. */
type HostInsets = { top: number; right: number; bottom: number; left: number };

/** A non-finite field interpolates to the valid-but-broken `"undefinedpx"`, so
 *  the page's `max(env(...), var(...))` drops the whole padding declaration. */
const hasValidInsets = (insets: HostInsets): boolean =>
  Number.isFinite(insets.top) &&
  Number.isFinite(insets.right) &&
  Number.isFinite(insets.bottom) &&
  Number.isFinite(insets.left);

/** Optional peer. `typeof require === 'function'` first (as in `storage.ts`):
 *  a bare `require` in the ESM build throws a `ReferenceError` the catch below
 *  would misreport as "peer not installed". */
const loadSafeAreaInsets = (
  hasRequire: () => boolean = () => typeof require === 'function',
  // A second seam, so the WIRING of `hasValidInsets` here is testable and not
  // only the predicate in isolation.
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

/** Test-only: `loadSafeAreaInsets`'s own wiring of the malformed-measurement
 *  guard, which `__hasValidInsetsForTest` cannot reach. */
export const __loadSafeAreaInsetsForTest = loadSafeAreaInsets;

/** `load` is an injectable seam so the Android fallback and the "nothing
 *  measurable" branch are testable. Production passes no arguments. */
const resolveHostInsets = (
  load: () => HostInsets | null = loadSafeAreaInsets,
): HostInsets | null => {
  const measured = load();
  if (measured) return measured;
  if (Platform.OS === 'android')
    return { top: StatusBar.currentHeight ?? 0, right: 0, bottom: 0, left: 0 };
  return null; // iOS, no peer: nothing to measure, nothing to inject
};

/** Test-only: the branch logic in `resolveHostInsets`. */
export const __resolveHostInsetsForTest = resolveHostInsets;

/** Test-only: the guard lives inside `loadSafeAreaInsets`, not
 *  `resolveHostInsets`, which trusts whatever `load()` returns. */
export const __hasValidInsetsForTest = hasValidInsets;

/** Not a bridge message, but keeps `injection`'s invariants: every value
 *  through `JSON.stringify`, and the script ends in `true;`. */
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

/** Hands EVERY navigation to `onShouldStartLoadWithRequest`; at the default the
 *  library resolves other schemes itself via `Linking.openURL`
 *  (`WebViewShared.tsx`), bypassing `isAllowedExternal`. Not the origin gate. */
const ALL_ORIGINS = ['*'];

/** `WebViewProps & undefined` reduces to `never`, so the library's default type
 *  argument makes every prop unassignable; `object` is the identity element. */
type Embedded = WebView<object>;

type NavigationRequest = Parameters<NonNullable<WebViewProps['onShouldStartLoadWithRequest']>>[0];
type MessageEvent = Parameters<NonNullable<WebViewProps['onMessage']>>[0];
type OpenWindowEvent = Parameters<NonNullable<WebViewProps['onOpenWindow']>>[0];
type ErrorEvent = Parameters<NonNullable<WebViewProps['onError']>>[0];
type TerminatedEvent = Parameters<NonNullable<WebViewProps['onContentProcessDidTerminate']>>[0];
type RenderProcessGoneEvent = Parameters<NonNullable<WebViewProps['onRenderProcessGone']>>[0];
type LoadEndEvent = Parameters<NonNullable<WebViewProps['onLoadEnd']>>[0];

/** Load failure: 3 attempts (immediate, then ~1s and ~2s with full jitter),
 *  cap 8s, then the error surface. Backoff from `retry.ts`. */
const LOAD_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  baseMs: 1000,
  capMs: 8000,
  totalBudgetMs: 8000,
};

/** 3 automatic crash recoveries plus the incident that gives up. One counter
 *  and one cap shared by both crash callbacks. */
const CRASH_RETRY_POLICY: RetryPolicy = {
  attempts: 4,
  baseMs: 1000,
  capMs: 8000,
  totalBudgetMs: 8000,
};

/** A handshake timeout is not a network failure: one silent `reload()`, then
 *  the error surface with a distinct code. No backoff. */
const HANDSHAKE_WATCHDOG_MS = 8000;
const HANDSHAKE_RECOVERY_CAP = 1;

/** Keyed on the runtime object, which `getRuntime` memoises per embed key, so
 *  this is "once per embed key" with no registry to clear. */
const warnedRuntimes = new WeakSet<MentioraRuntime>();

/** Embed the widget inline. Renders no chrome: the page draws its own header. */
export function MentioraWidget(props: MentioraWidgetProps): React.JSX.Element {
  const webview = useRef<Embedded | null>(null);

  const random = useRef<RandomSource | undefined>(undefined);
  if (!random.current) {
    random.current = createRandomSource({
      inject: (script) => webview.current?.injectJavaScript(script),
      // Only the composition root knows whether an ambient `crypto` is a real
      // host polyfill; without one the page round trip costs up to 2s of the 8s
      // budget. Cast at the seam: the lib.dom generic is wider than `RandomDeps`.
      ...(typeof globalThis.crypto?.getRandomValues === 'function'
        ? { globalCrypto: globalThis.crypto as RandomDeps['globalCrypto'] }
        : {}),
    });
  }
  const randomSource = random.current;

  // Every render: `getRuntime` swaps `runtime.identity` IN PLACE on reconfigure,
  // so everything below reads it live rather than calling a dead provider.
  const runtime = getRuntime(props);

  // The peer and the navigation handlers are built once and outlive prop
  // changes, so they read current props and runtime through this box.
  const latest = useRef<{ props: MentioraWidgetProps; runtime: MentioraRuntime }>({
    props,
    runtime,
  });
  latest.current = { props, runtime };

  /** The one external-link decision. `Linking.openURL` validates nothing of its
   *  own, so `isAllowedExternal` is the whole gate. */
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

  // Never trusted alone: `peer.sessionKey()`, re-read on every press, is what
  // proves a hold is still live across a reload/remount.
  const backHeld = useRef(false);

  /** Last committed top-frame URL, so a fragment-only navigation is told apart
   *  from a real one. A ref: read and written in a callback, must not render. */
  const lastTopUrl = useRef<string | null>(null);

  // Non-null only under a `<MentioraHost />`'s Modal; inline gets `null`, every
  // use below is then a no-op, and it keeps using `BackHandler`.
  const registerBackPress = useContext(BackChannelContext);

  const peerRef = useRef<HostPeer | undefined>(undefined);
  if (!peerRef.current) {
    peerRef.current = createHostPeer({
      send: (raw) => webview.current?.injectJavaScript(injection(raw)),
      handlers: {
        initialize: async () => {
          // Cleared SYNCHRONOUSLY, before any `await`: a page posting
          // `initialize` at 7.9s must disarm the 8s watchdog.
          clearWatchdogTimer();
          // Captured before the first await: work from an old generation may
          // neither mutate state nor send.
          const myGen = generation.current;
          try {
            // The session key first and alone: it shares the single-in-flight
            // random source with the install id, and serialising all three
            // spends the page's whole 8s budget.
            const sessionKey = toBase64Url(await randomSource.bytes(SESSION_KEY_BYTES));
            const { runtime: live } = latest.current;
            const [installId, identityToken] = await Promise.all([
              // The shared runtime is handed THIS WebView's source per call.
              live.installId(randomSource.bytes),
              live.identity.initial(),
            ]);
            // Success path only: zeroing on the way to a rejection turns the
            // catch below into an unbounded reload loop. `crashFailures` never
            // resets — a react-native-webview#1767 crasher boots fine, dies later.
            if (generation.current === myGen) {
              networkFailures.current = 0;
              handshakeTimeouts.current = 0;
            }
            // Always our own version, never `-32005`: a frozen v0 binary can
            // still serve a page that lists v1.
            return {
              protocolVersion: PROTOCOL_VERSION,
              sessionKey,
              installId,
              identityToken,
              sdk: { name: SDK_NAME, version: SDK_VERSION },
            };
          } catch (e) {
            // Re-arm: the synchronous disarm above is right for the 7.9s race
            // and fatal once the handler rejects — `handled` is still false and
            // `onLoadEnd` will not fire again, leaving the widget dead, no surface.
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
            // EVERY rejection, not just `IdentityUnavailable`: narrowing lets a
            // later plain `throw` downgrade to `-32603`, read as a bug on our side.
            throw new BridgeError(ErrorCode.identityUnavailable, 'Identity unavailable');
          }
        },
        openUrl: openExternal,
        onReady: () => latest.current.props.onEvent?.({ type: 'ready' }),
        onClose: () => latest.current.props.onEvent?.({ type: 'close' }),
        // `reason` only: the page's own message text is deliberately not carried.
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

  // -- The recovery coordinator ----------------------------------------
  // Refs, so a scheduled timer reads CURRENT counts/generation. Only
  // `errorCode`, `dismissed` and `remountKey` need a re-render.
  const [errorCode, setErrorCode] = useState<MentioraErrorCode | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [remountKey, setRemountKey] = useState(0);

  // A logout reloads EVERY mounted widget, so the subscription lives here. It
  // runs the whole of `restartLoad`: without that load boundary the new page's
  // `initialize` takes `-32600` and a stale `backHeld` claims its back presses.
  useEffect(() => {
    return runtime.onReload(() => restart.current());
  }, [runtime]);

  // The only reader of the runtime's `ephemeral`/`reason`: without persistence
  // every launch mints a new anonymous user and no thread survives. Warn AND
  // event, since `__DEV__` is stripped from release bundles. Once per runtime.
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
  /** Assigned during render, right after `restartLoad`. The effect above runs
   *  after commit, so it never calls this placeholder. */
  const restart = useRef<() => void>(() => {});

  const generation = useRef(0);
  // Has THIS generation already had its one terminal callback? An incident
  // raising two callbacks must still advance exactly one counter.
  const handled = useRef(false);
  const networkFailures = useRef(0);
  const crashFailures = useRef(0);
  const handshakeTimeouts = useRef(0);
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

  /** Runs `fn` only if no terminal callback has claimed this generation yet. */
  const onTerminal = (fn: () => void): void => {
    if (handled.current) return;
    handled.current = true;
    fn();
  };

  const showError = (code: MentioraErrorCode): void => {
    setErrorCode(code);
    latest.current.props.onEvent?.({ type: 'error', code });
  };

  /** A load boundary for OUR bookkeeping, in lockstep with `peer.resetLoad()`
   *  but counted apart. Cancels what is ticking; arms no new watchdog. */
  const advanceGeneration = (): void => {
    peer.resetLoad();
    // A back hold belongs to the document that claimed it, and this is where
    // that document ends; otherwise the next page's `initialize` revives it.
    backHeld.current = false;
    // A `bytes()` parked by the dead document would hold the single-in-flight
    // slot for its 2s timeout and reject the next `initialize` on line one.
    randomSource.reset();
    generation.current += 1;
    handled.current = false;
    clearRecoveryTimer();
    clearWatchdogTimer();
  };

  /** Arms the watchdog for the CURRENT generation: 8s for the page to call
   *  `initialize`. Called from mount, an allowed top-frame navigation,
   *  `onLoadEnd`, and the watchdog's own reload. Clears any existing timer. */
  const armWatchdog = (): void => {
    clearWatchdogTimer();
    const gen = generation.current;
    watchdogTimer.current = setTimeout(() => {
      watchdogTimer.current = null;
      if (generation.current !== gen) return; // a later generation cancels this
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

  /** Schedules the ladder's reload/remount `delayMs` from now, tagged to the
   *  CURRENT generation; it advances the generation itself before `action`. */
  const scheduleRecovery = (delayMs: number, action: () => void): void => {
    clearRecoveryTimer();
    const gen = generation.current;
    recoveryTimer.current = setTimeout(() => {
      recoveryTimer.current = null;
      if (generation.current !== gen) return; // superseded: don't reload a dead load
      advanceGeneration();
      action();
    }, delayMs);
  };

  // From the EFFECT, never the render body: a discarded render (StrictMode, an
  // interrupted transition) leaves a live timer that hands the host a spurious
  // `handshake_timeout`. Null-key guard: an Offscreen re-show must not re-arm.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; `peer` and `armWatchdog` read refs that are stable for this instance
  useEffect(() => {
    if (peer.sessionKey() === null) armWatchdog();
    return () => {
      if (watchdogTimer.current !== null) clearTimeout(watchdogTimer.current);
      if (recoveryTimer.current !== null) clearTimeout(recoveryTimer.current);
      // Retire the generation too: an `initialize` that rejects after unmount
      // must not re-arm the watchdog on a dead instance.
      generation.current += 1;
    };
  }, []);

  /** The platform-uniform re-arm point: a document that has finished loading,
   *  successfully or not, has 8s to speak. */
  const onLoadEnd = (_event: LoadEndEvent): void => {
    armWatchdog();
  };

  /** Suppress the library's own error view and run the load ladder instead: 3
   *  attempts, ~1s then ~2s with full jitter, then the error surface. */
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

  /** One counter and one cap shared by both crash callbacks; only `recover`
   *  differs — `reload()` on iOS, a remount on Android, which cannot reuse one. */
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

  /** A user-requested fresh attempt, and the `runtime.onReload` (logout) path:
   *  clear the surface, reset every ladder, cross a load boundary, remount.
   *  Always a remount — Android cannot reuse a killed renderer. Clearing
   *  `errorCode`/`dismissed` keeps logout from restarting behind a dead surface. */
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

  /** The only exit from a screen the user reached because the page drew no close
   *  control, so plain state: it works when everything else has given up. */
  const onDismiss = (): void => {
    setDismissed(true);
    // `setDismissed` above has already committed to stop rendering the WebView,
    // whatever the host's callback does next.
    try {
      latest.current.props.onEvent?.({ type: 'close' });
    } catch {
      // Dismiss has already done its one job.
    }
  };

  // -- Insets and Android back -----------------------------------------

  // Computed once — nothing measurable changes — and re-sent on every load
  // boundary. `null` is a valid memoized answer, hence the separate guard ref.
  const hostInsetsComputed = useRef(false);
  const hostInsets = useRef<HostInsets | null>(null);
  if (!hostInsetsComputed.current) {
    hostInsetsComputed.current = true;
    hostInsets.current = resolveHostInsets();
  }

  // Reads only refs, so `[]` is genuinely exhaustive and the identity stays
  // stable, which is what lets the mount effect below run exactly once.
  const injectHostInsets = useCallback((): void => {
    const insets = hostInsets.current;
    if (insets) webview.current?.injectJavaScript(hostInsetsScript(insets));
  }, []);

  // Its own effect: the first load's `onLoadEnd` has not fired when a slow page
  // or a test first inspects what we sent, and `webview` attaches after commit.
  useEffect(() => {
    injectHostInsets();
  }, [injectHostInsets]);

  /** Forwards `mentiora/back` while the page holds the button, else unhandled
   *  and the host dismisses. `backHeld` alone is not trusted — only
   *  `peer.sessionKey() !== null` at PRESS TIME proves the hold survived a
   *  reload. `dismissed`/`errorCode` first: the give-up crosses no boundary. */
  const onHardwareBack = useCallback((): boolean => {
    if (dismissed || errorCode !== null) return false;
    if (backHeld.current && peer.sessionKey() !== null) {
      peer.sendBack();
      return true;
    }
    return false;
  }, [peer, dismissed, errorCode]);

  // `useLayoutEffect`: `showError` runs from a timer, whose passive effects
  // flush a task later — a press in that gap would run the previous closure.
  useLayoutEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', onHardwareBack);
    // The SAME decision handed to the Modal's `onRequestClose`, never a second
    // one; registering here replaces a stale closure atomically.
    registerBackPress?.(onHardwareBack);
    // `.remove()` on the subscription — never `BackHandler.removeEventListener`,
    // deleted in RN 0.77, which throws if called.
    return () => {
      subscription.remove();
      registerBackPress?.(null);
    };
  }, [onHardwareBack, registerBackPress]);

  const onMessage = useCallback(
    (event: MessageEvent) => {
      const raw = event.nativeEvent.data;
      // BEFORE the JSON-RPC parser: the random reply is not JSON-RPC and would
      // be answered `-32600` by the peer.
      if (randomSource.acceptReply(raw)) return;
      void peer.receive(raw);
    },
    [peer, randomSource],
  );

  // Not `useCallback`: it calls `beginFreshLoad`, rebuilt every render anyway,
  // and both close over refs, so identity does not matter.
  const onShouldStartLoadWithRequest = (request: NavigationRequest): boolean => {
    const { url, isTopFrame, navigationType } = request;
    if (isSameOrigin(url, latest.current.props.widgetOrigin)) {
      // The identifiable load boundaries: mount, and an allowed TOP-FRAME
      // navigation. Never a bare `onLoadStart` — Android raises it from
      // `doUpdateVisitedHistory`, so resetting there kills the session key
      // mid-document and later messages take `-32001`. A fragment jump is none.
      if (isTopFrame) {
        const previous = lastTopUrl.current;
        lastTopUrl.current = url;
        if (previous === null || navigationType === 'reload' || !isSameDocument(previous, url))
          beginFreshLoad();
      }
      return true;
    }
    // Denied here, handed to the OS: the navigation is already blocked, and
    // there is no JSON-RPC id behind a navigation to report on.
    void openExternal(url).catch(() => {});
    return false;
  };

  const onOpenWindow = useCallback(
    (event: OpenWindowEvent) => {
      void openExternal(event.nativeEvent.targetUrl).catch(() => {});
    },
    [openExternal],
  );

  // Checked first, so Dismiss wins over an error surface a stray in-flight timer
  // sets afterwards.
  if (dismissed) return <View />;

  return (
    <View style={styles.container}>
      <WebView<object>
        // Android cannot reuse a dead renderer; `onRenderProcessGone`'s recovery
        // bumps this key to force a fresh one.
        key={remountKey}
        ref={webview}
        testID="mentiora-webview"
        style={styles.webview}
        // encodeURIComponent: `embedKey` is customer input, one path segment.
        // `widgetOrigin`/`embedKey` are FIXED per instance — `key` the component
        // to change either: Android raises `onShouldStartLoadWithRequest` only
        // from `shouldOverrideUrlLoading` (`RNCWebViewClient.java`).
        source={{ uri: `${props.widgetOrigin}/h/rn/${encodeURIComponent(props.embedKey)}` }}
        onMessage={onMessage}
        originWhitelist={ALL_ORIGINS}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        // Its absence is CVE-2020-6506: without it a target=_blank load
        // silently replaces the top frame instead of raising `onOpenWindow`.
        setSupportMultipleWindows={true}
        onOpenWindow={onOpenWindow}
        webviewDebuggingEnabled={__DEV__}
        onError={onError}
        onContentProcessDidTerminate={onContentProcessDidTerminate}
        onRenderProcessGone={onRenderProcessGone}
        onLoadEnd={(event) => {
          onLoadEnd(event);
          // A fresh document has none of the previous one's custom properties.
          injectHostInsets();
        }}
        // The overlay does not remove the WebView, so hide the dead page from
        // TalkBack while the overlay owns the screen.
        importantForAccessibility={errorCode !== null ? 'no-hide-descendants' : 'auto'}
      />
      {/* An overlay, not a swap: the WebView stays mounted underneath, so
       *  `injectJavaScript`/`reload` stay live for whichever ladder still ticks. */}
      {errorCode !== null && (
        // iOS: tells VoiceOver everything outside this view is off-screen,
        // matching the Android attribute above.
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
