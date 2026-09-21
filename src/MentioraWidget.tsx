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
 * Load failure, crash recovery and the handshake watchdog are Task 11b (below).
 * Insets and the back button are Task 11c.
 *
 * Task 11b — the recovery coordinator (design.md §2.5, §2.9). Three
 * independent timers can all be live for the same page load — the network
 * retry ladder (`onError`), the crash ladder (`onContentProcessDidTerminate` /
 * `onRenderProcessGone`), and the handshake watchdog (no `initialize` within
 * 8s) — and without an ownership rule one incident drives two of them: an
 * `initialize` accepted at 7.9s races the still-live 8s watchdog; a crash just
 * before the watchdog expires gets doubly "recovered"; one incident can raise
 * both `onError` and `onRenderProcessGone`. So:
 *
 * - Every timer is tagged with the local `generation` it was armed under (a
 *   counter kept in lockstep with the peer's own via `resetLoad()`, but a
 *   separate counter — the peer's is for session-key enforcement, this one is
 *   for timer staleness). A timer whose generation no longer matches the
 *   current one is a no-op when it fires.
 * - `handled` gates ALL THREE ladders together: only the first terminal
 *   callback for a generation (network error, crash, or watchdog timeout —
 *   whichever fires first) picks a recovery path and advances a counter;
 *   every other one for that generation, of any kind, is ignored.
 * - The watchdog is armed only on a fresh top-level load boundary — mount, an
 *   allowed top-frame navigation, or its own single self-triggered reload —
 *   never by a network- or crash-ladder reload. Those already know the load
 *   failed; re-arming the watchdog on their reload would let it race their
 *   own recovery and misreport `handshake_timeout` for an incident that was
 *   already being handled (confirmed by working the exact numbers: the
 *   watchdog's 8s is shorter than the 9s a test needs to observe a ladder's
 *   jittered reload, so a rearmed watchdog fires inside that same window on
 *   every single recovery — it would never converge). A network/crash reload
 *   still clears the CURRENT watchdog (it's for the load that just ended).
 * - A valid `initialize` clears the watchdog SYNCHRONOUSLY (the first line of
 *   the `initialize` handler below, before any `await`) — not in an effect,
 *   not after the round trip for the session-key bytes completes.
 *
 * Dismiss does not depend on any of this: it is plain component state, so it
 * still works when the peer, the runtime, or every ladder above has already
 * given up.
 */
import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import type { WebViewProps } from 'react-native-webview';
import { WebView } from 'react-native-webview';
import { BridgeError, createHostPeer, type HostPeer } from './bridge/peer.js';
import { ErrorCode, PROTOCOL_VERSION } from './bridge/protocol.js';
import { isAllowedExternal, isSameOrigin } from './links.js';
import { createRandomSource, type RandomDeps, type RandomSource, toBase64Url } from './random.js';
import { delaysFor, type RetryPolicy } from './retry.js';
import { getRuntime, type MentioraRuntime } from './runtime.js';
import type { MentioraErrorCode, MentioraWidgetProps } from './types.js';
import { ErrorScreen } from './ui/ErrorScreen.js';
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
type ErrorEvent = Parameters<NonNullable<WebViewProps['onError']>>[0];
type TerminatedEvent = Parameters<NonNullable<WebViewProps['onContentProcessDidTerminate']>>[0];
type RenderProcessGoneEvent = Parameters<NonNullable<WebViewProps['onRenderProcessGone']>>[0];

/** design.md §2.9: load failure — 3 attempts (an immediate first try, then
 *  ~1s and ~2s with full jitter), cap 8s, then the error surface. Reused
 *  as-is via `retry.ts`'s `delaysFor` rather than a second backoff formula. */
const LOAD_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  baseMs: 1000,
  capMs: 8000,
  totalBudgetMs: 8000,
};

/** design.md §2.5: "bounded at 3 automatic recoveries with backoff, then the
 *  error surface" — 3 recoveries plus the incident that gives up is 4 total,
 *  matching `RetryPolicy.attempts`'s "total tries" meaning the load ladder
 *  above already uses. Shared by BOTH `onContentProcessDidTerminate` and
 *  `onRenderProcessGone` (§2.5: "Either way ... a fresh session key is
 *  issued" — one counter, one cap, regardless of which callback fired). */
const CRASH_RETRY_POLICY: RetryPolicy = {
  attempts: 4,
  baseMs: 1000,
  capMs: 8000,
  totalBudgetMs: 8000,
};

/** design.md §2.9: "Handshake timeout is not a network failure and does not
 *  use that ladder... One silent reload(), then the error surface with a
 *  distinct code." No jitter, no backoff — a single unconditional recheck. */
const HANDSHAKE_WATCHDOG_MS = 8000;
const HANDSHAKE_RECOVERY_CAP = 1;

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
          // Cleared SYNCHRONOUSLY, before the first `await` below — not in an
          // effect, not after the random-bytes round trip. This runs inside
          // `peer.receive`'s synchronous prefix (up to its own first await),
          // which itself runs inside `onMessage`'s synchronous dispatch, so it
          // executes in the same tick `fireEvent`/the real bridge message
          // arrives in. A page that posts `initialize` at 7.9s must disarm the
          // 8s watchdog before it can race a handshake that is about to
          // succeed (11b, "one recovery coordinator per load generation").
          // A page that reaches this point at all is proof of life for every
          // ladder, not just the watchdog's — reset the network and crash
          // counters too, so a transient blip long ago does not count against
          // a page that has since loaded cleanly.
          clearWatchdogTimer();
          networkFailures.current = 0;
          crashFailures.current = 0;
          handshakeTimeouts.current = 0;
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

  // -- 11b: the recovery coordinator -----------------------------------
  //
  // State only, never re-derived: refs so a scheduled timer's closure always
  // reads the CURRENT counts/generation through `.current`, not whatever they
  // were when that timer was scheduled. `errorCode`, `dismissed` and
  // `remountKey` are the only pieces that need to trigger a re-render, so
  // they alone are `useState`.
  const [errorCode, setErrorCode] = useState<MentioraErrorCode | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [remountKey, setRemountKey] = useState(0);

  const generation = useRef(0);
  // Has THIS generation already had its one terminal callback? Shared across
  // all three ladders — an incident that raises two callbacks (design.md's
  // own example) must advance exactly one counter, not two.
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

  /** A load boundary for OUR OWN bookkeeping, kept in lockstep with the
   *  peer's (`resetLoad`) rather than reusing its counter — that one is for
   *  session-key enforcement, this one is for timer staleness. Cancels
   *  whatever is currently ticking; it does NOT arm a new watchdog — see
   *  `armWatchdog`'s own doc for why a network/crash reload must not. */
  const advanceGeneration = (): void => {
    peer.resetLoad();
    generation.current += 1;
    handled.current = false;
    clearRecoveryTimer();
    clearWatchdogTimer();
  };

  /** Arms the handshake watchdog for the CURRENT generation. Called only from
   *  a fresh top-level load boundary: mount, an allowed top-frame navigation,
   *  or the watchdog's own single self-triggered reload — never from the
   *  network or crash ladder's reload. Those already know their load failed;
   *  giving them a rearmed watchdog too would let it race their own recovery
   *  action (the watchdog's fixed 8s is shorter than the ~9s a test needs to
   *  observe a jittered reload, so a rearmed watchdog fires inside that same
   *  window on every single recovery and misreports `handshake_timeout` for
   *  an incident a different ladder is already handling). A network/crash
   *  reload still goes through `advanceGeneration`, so the watchdog that was
   *  ticking for the load that just failed is cancelled — just not replaced. */
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

  /** Schedules the ladder's own reload/remount `delayMs` from now, tagged to
   *  the CURRENT generation. When it fires, it advances the generation itself
   *  (never the watchdog's job) and then runs `action`. */
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

  // Mount arms the initial watchdog directly — no `advanceGeneration` call,
  // for the same reason 11a's `onShouldStartLoadWithRequest` never calls
  // `resetLoad()` on mount: a freshly built peer already IS generation 0.
  // Guarded like `peerRef`/`random` above so it runs exactly once, ever, for
  // this component instance, however many times React (re-)renders it.
  const mountWatchdogArmed = useRef(false);
  if (!mountWatchdogArmed.current) {
    mountWatchdogArmed.current = true;
    armWatchdog();
  }

  /** design.md §2.9: suppress the library's own error view and run the load
   *  ladder instead — 3 attempts total (this one plus up to 2 more), ~1s then
   *  ~2s with full jitter, then the error surface. */
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

  /** design.md §2.5: one counter, one cap, shared by both crash callbacks —
   *  `recover` is the one difference (`reload()` for iOS, a remount-key bump
   *  for Android, since a dead Android renderer must be removed from the
   *  hierarchy, never reused). */
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

  /** A fresh, user-requested attempt: clear the surface, give every ladder a
   *  clean slate, treat it exactly like a new top-level load, and actually
   *  make the still-mounted WebView try again — the overlay coming down does
   *  not itself do that. */
  const onRetry = (): void => {
    networkFailures.current = 0;
    crashFailures.current = 0;
    handshakeTimeouts.current = 0;
    beginFreshLoad();
    webview.current?.reload();
    setErrorCode(null);
  };

  /** The only exit from a screen the user reached because the page never drew
   *  its own close control — it must work even when the peer, the runtime and
   *  every ladder above have already given up. Plain component state and the
   *  host's own `onEvent`, nothing else; `dismissed` is checked before
   *  `errorCode` in the render below, so this wins over anything a stray
   *  in-flight timer does afterwards. */
  const onDismiss = (): void => {
    setDismissed(true);
    latest.current.props.onEvent?.({ type: 'close' });
  };

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

  // Not `useCallback`: it calls `beginFreshLoad`, which is rebuilt every
  // render anyway (it closes over refs, not state, so identity doesn't matter
  // — same reasoning as `onError`/`onRenderProcessGone` below).
  const onShouldStartLoadWithRequest = (request: NavigationRequest): boolean => {
    const { url, isTopFrame } = request;
    if (isSameOrigin(url, latest.current.props.widgetOrigin)) {
      // A load boundary is an identifiable one: initial mount (a freshly built
      // peer already IS generation 0 with no session key) and an allowed
      // TOP-FRAME navigation. Never a bare `onLoadStart` — Android raises that
      // from `doUpdateVisitedHistory`, which also sees in-page history changes,
      // so resetting there clears the session key mid-document and every later
      // message takes `-32001`. A sub-frame — the custom-block sandbox iframe —
      // is the same document and must not reset anything either (§2.2). A
      // top-frame nav is a fresh top-level load exactly like mount, so it
      // gets its own fresh handshake watchdog too (11b).
      if (isTopFrame) beginFreshLoad();
      return true;
    }
    // Denied here, handed to the OS. The navigation is already blocked, and a
    // link the OS will not take has nowhere to be reported: there is no
    // JSON-RPC id behind a navigation.
    void openExternal(url).catch(() => {});
    return false;
  };

  const onOpenWindow = useCallback(
    (event: OpenWindowEvent) => {
      void openExternal(event.nativeEvent.targetUrl).catch(() => {});
    },
    [openExternal],
  );

  // Dismiss is the only one of the two that actually stops rendering the
  // WebView (11b resolution 4) — checked first so it wins over anything else,
  // including an error surface a stray in-flight timer sets afterwards.
  if (dismissed) return <View />;

  return (
    <View style={styles.container}>
      <WebView<object>
        // Android's own docs are explicit that a dead renderer must be removed
        // from the hierarchy and destroyed, never reused — `onRenderProcessGone`'s
        // recovery bumps this key to force exactly that (design.md §2.5).
        key={remountKey}
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
        onError={onError}
        onContentProcessDidTerminate={onContentProcessDidTerminate}
        onRenderProcessGone={onRenderProcessGone}
      />
      {/* An overlay, not a swap: the WebView stays mounted underneath (its
       *  `injectJavaScript`/`reload` stay live for whichever ladder is still
       *  ticking) until Retry or Dismiss actually acts. Retry's own reload is
       *  what makes the page try again — this screen is just what covers a
       *  page that, on its own, never draws anything at all (§2.9). */}
      {errorCode !== null && (
        <View style={StyleSheet.absoluteFill}>
          <ErrorScreen code={errorCode} onRetry={onRetry} onDismiss={onDismiss} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },
});
