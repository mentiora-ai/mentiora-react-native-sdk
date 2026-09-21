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
 * - **The watchdog is (re-)armed from `onLoadEnd`**, not from a network- or
 *   crash-ladder reload. `onLoadEnd` fires once a document has actually
 *   finished loading — successfully or not — which is what §2.9's 8s is
 *   really about: a document that has committed now has 8s to speak. Mount
 *   still arms it directly too, as a floor for the very first load. Arming
 *   from a ladder's own `reload()`/remount call instead would be a mock
 *   artifact of a different kind than it looks: the mock's `reload()` is a
 *   bare `jest.fn()` that fires no navigation callback at all, but even on
 *   a real device neither platform's own reload-triggered navigation
 *   callback is a substitute — iOS's `decidePolicyForNavigationAction` does
 *   run for a `reload()`, so `onShouldStartLoadWithRequest` would eventually
 *   re-arm it there, but Android's `shouldOverrideUrlLoading` is documented
 *   to NOT run for `WebView.reload()`, so on Android a network/crash-ladder
 *   reload that succeeds at the HTTP level but whose page never calls
 *   `initialize` again would arm nothing, show nothing, and leave no exit —
 *   exactly the trap this screen exists to prevent, reached through the
 *   recovery path that is supposed to prevent it. `onLoadEnd` has no such
 *   platform gap. The one exception is the watchdog's OWN self-triggered
 *   reload, which still re-arms itself immediately (`beginFreshLoad`) rather
 *   than waiting on `onLoadEnd` — its contract is "one silent reload, then
 *   an unconditional recheck in 8s", not "whenever this reload happens to
 *   finish".
 * - A valid `initialize` clears the watchdog SYNCHRONOUSLY (the first line of
 *   the `initialize` handler below, before any `await`) — not in an effect,
 *   not after the round trip for the session-key bytes completes.
 *
 * Dismiss does not depend on any of this: it is plain component state, so it
 * still works when the peer, the runtime, or every ladder above has already
 * given up. Unmounted state is cleaned up in a `useEffect` — this is the one
 * piece of 11b that has to be an effect, since there is no synchronous "the
 * component is being torn down" hook to hang it on instead.
 */
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
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
type LoadEndEvent = Parameters<NonNullable<WebViewProps['onLoadEnd']>>[0];

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

  /** Arms the handshake watchdog for the CURRENT generation: 8s for the page
   *  to call `initialize`, starting now. Called from mount (a floor for the
   *  very first load), from an allowed top-frame navigation, from
   *  `onLoadEnd` (the real, platform-uniform re-arm point — see the header
   *  comment for why a network/crash reload's own `reload()`/remount call
   *  must NOT arm this directly), and from the watchdog's own single
   *  self-triggered reload (which re-arms itself immediately rather than
   *  waiting on that reload's own `onLoadEnd`, because its contract is "one
   *  silent reload, then an unconditional recheck in 8s"). A network/crash
   *  reload still goes through `advanceGeneration`, so the watchdog that was
   *  ticking for the load that just failed is cancelled — just not replaced
   *  until that reload's `onLoadEnd` arrives. */
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

  // Without this, an unmounted widget's mount-armed watchdog is still live:
  // `beginFreshLoad` fires `peer.resetLoad()` on a peer nobody reads from
  // any more, and the eventual `showError` calls `onEvent` on a widget the
  // host already closed. Empty deps: this is a teardown-only effect, not a
  // sync-with-props one, and it is the one piece of 11b that has to be an
  // effect — there is no synchronous "about to unmount" hook to use instead.
  // Clears the refs directly (not via `clearWatchdogTimer`/`clearRecoveryTimer`,
  // which are plain functions rebuilt every render and so would either force
  // this effect to rerun on every render or fail exhaustive-deps) — `useRef`
  // objects are themselves stable, so reading `.current` here needs no
  // dependency at all.
  useEffect(() => {
    return () => {
      if (watchdogTimer.current !== null) clearTimeout(watchdogTimer.current);
      if (recoveryTimer.current !== null) clearTimeout(recoveryTimer.current);
    };
  }, []);

  /** design.md §2.9: the real, platform-uniform re-arm point — a document
   *  that has finished loading, successfully or not, has 8s to speak. See
   *  the file header for why a ladder's own reload must not arm this
   *  directly instead. */
  const onLoadEnd = (_event: LoadEndEvent): void => {
    armWatchdog();
  };

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
   *  make it try again. Always a remount (the `key` bump), never a bare
   *  `reload()`: `renderer_crashed` can be what's showing, and `reload()` on
   *  a renderer Android already killed is not a repair, it's the same dead
   *  instance asked to do the one thing Android's own docs say it cannot —
   *  a remount is correct for every code, not just that one. */
  const onRetry = (): void => {
    networkFailures.current = 0;
    crashFailures.current = 0;
    handshakeTimeouts.current = 0;
    beginFreshLoad();
    setRemountKey((k) => k + 1);
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
    // The one `onEvent` call that must not be able to take the exit down
    // with it: `setDismissed` above has already committed to stop rendering
    // the WebView regardless of what the host's own callback does next.
    try {
      latest.current.props.onEvent?.({ type: 'close' });
    } catch {
      // Nothing to do with a throwing host callback here — Dismiss has
      // already done its one job.
    }
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
        onLoadEnd={onLoadEnd}
        // The overlay below covers this WebView but does not remove it from
        // the tree (see its own comment), so without this a screen reader
        // can still reach the dead page underneath the one screen that is
        // supposed to be the only way out. Android: hide the whole subtree
        // from TalkBack while the overlay owns the screen.
        importantForAccessibility={errorCode !== null ? 'no-hide-descendants' : 'auto'}
      />
      {/* An overlay, not a swap: the WebView stays mounted underneath (its
       *  `injectJavaScript`/`reload` stay live for whichever ladder is still
       *  ticking) until Retry or Dismiss actually acts. Retry's own reload is
       *  what makes the page try again — this screen is just what covers a
       *  page that, on its own, never draws anything at all (§2.9). */}
      {errorCode !== null && (
        // iOS: tells VoiceOver everything outside this view is not part of
        // the current screen, matching Android's `importantForAccessibility`
        // above on the WebView it is covering.
        <View style={StyleSheet.absoluteFill} accessibilityViewIsModal={true}>
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
