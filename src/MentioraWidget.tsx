/**
 * The composition root. Everything else in this package is a module with a
 * contract and no collaborators; this is the only file where they meet.
 *
 * - `react-native-webview` has exactly ONE inbound channel and ONE outbound
 *   channel. Inbound is `onMessage`, set unconditionally: the library injects
 *   `window.ReactNativeWebView.postMessage` into the page only when a handler
 *   is present, and without it the bridge silently does not exist. Outbound is
 *   `injectJavaScript`, which reports nothing and does nothing at all if the
 *   script does not end in `true;`.
 * - The random handshake sits INSIDE the `initialize` handler: the session key
 *   needs 16 bytes, and those bytes come back from the page over a second
 *   round trip on the same channel. So `onMessage` hands every payload to
 *   `randomSource.acceptReply` BEFORE the JSON-RPC parser — the reply is not
 *   JSON-RPC and must never reach the peer.
 *
 * One peer and one session key per WebView, both per page load by definition.
 * Storage, the install id and the identity provider come from the shared
 * per-`embedKey` runtime; nothing per-load is ever put on the runtime.
 *
 * The recovery coordinator. Three timers can be live for one page load — the
 * network retry ladder (`onError`), the crash ladder
 * (`onContentProcessDidTerminate` / `onRenderProcessGone`) and the handshake
 * watchdog (no `initialize` within 8s) — and one incident can drive two of
 * them, so ownership is fixed by three rules:
 *
 * - Every timer is tagged with the local `generation` it was armed under, and
 *   is a no-op when it fires if that no longer matches. The counter is kept in
 *   lockstep with the peer's via `resetLoad()` but stays separate: the peer's
 *   is for session-key enforcement, this one for timer staleness.
 * - `handled` gates ALL THREE ladders together, so only the first terminal
 *   callback for a generation picks a recovery path and advances a counter.
 * - The watchdog is (re-)armed from `onLoadEnd`, never from a ladder's own
 *   reload, because Android's `shouldOverrideUrlLoading` is documented NOT to
 *   run for `WebView.reload()`: `onShouldStartLoadWithRequest` never fires
 *   there, so a recovery reload whose page never calls `initialize` again
 *   would arm nothing, show nothing and leave no exit. iOS has no such gap
 *   (`decidePolicyForNavigationAction` does run for a reload). Mount arms the
 *   watchdog directly as a floor for the first load, and the watchdog's own
 *   single reload re-arms immediately rather than waiting for `onLoadEnd`,
 *   its rule being "one silent reload, then an unconditional recheck in 8s".
 * - A valid `initialize` clears the watchdog SYNCHRONOUSLY, in the handler's
 *   first line, before any `await`.
 *
 * Dismiss depends on none of this: it is plain component state, so it works
 * when the peer, the runtime and every ladder have already given up.
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

/**
 * Host → page framing. Two things here fail silently when broken, which is why
 * neither is inlined at the call site:
 * - the trailing `true;`, without which `injectJavaScript` is a no-op;
 * - `JSON.stringify` of the raw JSON *string*, never concatenation. `receive`
 *   takes the same string shape the page posts back to us, so the argument is
 *   stringified a second time to become a JS string literal.
 */
const injection = (raw: string): string =>
  `window.mentioraHost.receive(${JSON.stringify(raw)});true;`;

/**
 * The page takes `max(env(safe-area-inset-*), --mw-host-inset-*)` and tracks
 * `visualViewport` itself; we never claim `reportsViewport`.
 *
 * The four `--mw-host-inset-*` custom properties are set ONLY when something
 * is actually measurable: `react-native-safe-area-context` when present (Expo
 * Go bundles it, and `initialWindowMetrics` is filled in by the native module
 * at JS startup, so it needs no `<SafeAreaProvider>` ancestor, which this
 * widget cannot assume the host mounted), else `StatusBar.currentHeight` on
 * Android, where `env()` has no meaningful value in WebView before M136. On
 * iOS with no peer, `resolveHostInsets` returns `null` and nothing is injected
 * — never a fabricated `0` the page would trust as a floor.
 */
type HostInsets = { top: number; right: number; bottom: number; left: number };

/** `insets.top/right/bottom/left` are interpolated straight into a CSS length
 *  (`${px}px`) with no further validation downstream, so a non-numeric field
 *  from a peer whose shape is not what we expect becomes the token
 *  `"undefinedpx"`. That is a syntactically VALID custom-property value, so
 *  nothing throws; the page's `max(env(...), var(--mw-host-inset-top))` then
 *  fails at computed-value time and the whole padding declaration is dropped,
 *  not just the one side — worse than never setting the property. Reject the
 *  measurement outright rather than pass any part of it through. */
const hasValidInsets = (insets: HostInsets): boolean =>
  Number.isFinite(insets.top) &&
  Number.isFinite(insets.right) &&
  Number.isFinite(insets.bottom) &&
  Number.isFinite(insets.left);

/**
 * `react-native-safe-area-context` is an optional peer, resolved the way
 * `storage.ts` resolves `@react-native-async-storage/async-storage`:
 * `typeof require === 'function'` first, because a bare `require` is emitted
 * verbatim into the ESM build where it has no synchronous form at all, and its
 * `ReferenceError` would otherwise be caught below and misreported as "peer
 * not installed"; then a try/catch around the require for the peer genuinely
 * being absent.
 */
const loadSafeAreaInsets = (
  hasRequire: () => boolean = () => typeof require === 'function',
  // A second injectable seam, not just `hasRequire`, so the WIRING of
  // `hasValidInsets` into this function is testable and not only the predicate
  // in isolation: deleting the `hasValidInsets` call here is invisible to a
  // test that only calls `hasValidInsets` itself.
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

/** Test-only: exercises `loadSafeAreaInsets`'s own wiring of the
 *  malformed-measurement guard through its `requireModule` seam, which
 *  `__hasValidInsetsForTest` cannot reach. */
export const __loadSafeAreaInsetsForTest = loadSafeAreaInsets;

/**
 * `load` is an injectable seam (as in `storage.ts`'s `resolveStorage` and
 * `random.ts`'s `globalCrypto`) so the Android fallback and the "nothing
 * measurable" branch are each testable without fighting Jest's module cache
 * over a peer that may or may not be installed in a given run. Production
 * always calls this with no arguments.
 */
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

/** Test-only: the malformed-measurement guard lives inside
 *  `loadSafeAreaInsets`, never inside `resolveHostInsets`, which trusts
 *  whatever `load()` returns — so it needs its own hook rather than being
 *  reachable through `__resolveHostInsetsForTest`'s injected `load`. */
export const __hasValidInsetsForTest = hasValidInsets;

/**
 * A plain style write, not a bridge message — `window.mentioraHost.receive`
 * does not apply — but it keeps `injection`'s two invariants: every
 * interpolated value goes through `JSON.stringify`, and the script ends in
 * `true;`.
 */
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

/**
 * Hands EVERY navigation to `onShouldStartLoadWithRequest`. Left at its default
 * (`http://*`, `https://*`), `react-native-webview` resolves a non-matching
 * scheme itself — `Linking.canOpenURL` then `openURL`, our handler never called
 * (`WebViewShared.tsx`, `createOnShouldStartLoadWithRequest`) — so `intent:`,
 * `file:` and friends would reach the OS without passing `isAllowedExternal`.
 * This is not the origin gate; `isSameOrigin` is, and `originWhitelist` could
 * not be, being prefix-anchored.
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

/** Load failure: 3 attempts (an immediate first try, then ~1s and ~2s with
 *  full jitter), cap 8s, then the error surface. Reuses `retry.ts`'s
 *  `delaysFor` rather than a second backoff formula. */
const LOAD_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  baseMs: 1000,
  capMs: 8000,
  totalBudgetMs: 8000,
};

/** Bounded at 3 automatic crash recoveries with backoff, then the error
 *  surface: 3 recoveries plus the incident that gives up is the 4 total that
 *  `RetryPolicy.attempts` means here, as in the load ladder above. One counter
 *  and one cap shared by BOTH `onContentProcessDidTerminate` and
 *  `onRenderProcessGone`, whichever fired. */
const CRASH_RETRY_POLICY: RetryPolicy = {
  attempts: 4,
  baseMs: 1000,
  capMs: 8000,
  totalBudgetMs: 8000,
};

/** A handshake timeout is not a network failure and does not use that ladder:
 *  one silent `reload()`, then the error surface with a distinct code. No
 *  jitter, no backoff — a single unconditional recheck. */
const HANDSHAKE_WATCHDOG_MS = 8000;
const HANDSHAKE_RECOVERY_CAP = 1;

/** Which runtimes have already reported degraded storage. Keyed on the runtime
 *  object, which `getRuntime` memoises per embed key and never rebuilds, so
 *  this is "once per embed key" with no registry to clear: `__resetRuntimes()`
 *  produces fresh objects and the old entries fall out of the WeakSet. */
const warnedRuntimes = new WeakSet<MentioraRuntime>();

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
      // here is a real host polyfill, which in React Native means the app
      // installed one. Without it, the page round trip for random bytes costs
      // up to 2s of the 8s handshake budget.
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
  // `identity` reference (runtime.ts, last config wins). Everything below reads
  // `runtime.identity` live for the same reason — a local copy goes stale after
  // a reconfigure, leaving this widget calling a provider nobody is configured
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

  // Does the page currently hold the hardware back button? Never trusted at
  // face value: `peer.sessionKey()`, re-read on every press (see
  // `onHardwareBack` below), is what proves a hold is still live, since a
  // reload/remount resets it synchronously and this ref alone does not.
  const backHeld = useRef(false);

  /** The top-frame URL this WebView last committed to, so a fragment-only
   *  navigation can be told apart from a real one. A ref, not state: it is read
   *  and written inside a navigation callback and must never schedule a
   *  render. */
  const lastTopUrl = useRef<string | null>(null);

  // Non-null only when a `<MentioraHost />`'s Modal is an ancestor;
  // `back-channel.ts`'s header has the reasoning. An inline widget gets `null`
  // here, every use below is then a no-op, and it keeps using `BackHandler`.
  const registerBackPress = useContext(BackChannelContext);

  const peerRef = useRef<HostPeer | undefined>(undefined);
  if (!peerRef.current) {
    peerRef.current = createHostPeer({
      send: (raw) => webview.current?.injectJavaScript(injection(raw)),
      handlers: {
        initialize: async () => {
          // Cleared SYNCHRONOUSLY, before the first `await` below. This runs
          // inside `peer.receive`'s synchronous prefix, itself inside
          // `onMessage`'s synchronous dispatch, so it executes in the tick the
          // bridge message arrives in: a page that posts `initialize` at 7.9s
          // disarms the 8s watchdog before it can race a handshake that is
          // about to succeed.
          clearWatchdogTimer();
          // Captured before the first await, so a handler whose document has
          // since been replaced mutates nothing — the same rule `peer.receive`
          // keeps for its own sends: work from an old generation may neither
          // mutate state nor send.
          const myGen = generation.current;
          try {
            // The session key comes first and alone: it shares the
            // single-in-flight random source with the install id, so those two
            // cannot overlap. Identity never touches `randomBytes`, and
            // serialising all three spends 2s + 2s + `BOOT_RETRY_POLICY`'s 4s =
            // exactly the 8s the page bounds the handshake by, so a slow
            // identity endpoint would surface as `handshake_timeout` instead of
            // chat. Overlapping the last two gives up to 2s of that back.
            const sessionKey = toBase64Url(await randomSource.bytes(SESSION_KEY_BYTES));
            const { runtime: live } = latest.current;
            const [installId, identityToken] = await Promise.all([
              // The runtime is shared across widgets, so it is handed THIS WebView's
              // source per call rather than owning one (runtime.ts).
              live.installId(randomSource.bytes),
              live.identity.initial(),
            ]);
            // A page that gets THIS FAR proves the transport works, so a blip
            // long ago does not count against a page that has since loaded
            // cleanly. Success path only: zeroing the watchdog's counter on the
            // way to a rejection turns the catch below into an unbounded reload
            // loop instead of one-reload-then-error.
            //
            // `crashFailures` deliberately does NOT reset. A page that crashes
            // deterministically (`react-native-webview`#1767) boots fine and
            // dies later, when it renders the thread, so resetting here would
            // clear its crash budget every cycle and leave it remounting and
            // reloading forever on battery. Retry (`restartLoad`) is the
            // explicit way to buy a fresh crash budget.
            if (generation.current === myGen) {
              networkFailures.current = 0;
              handshakeTimeouts.current = 0;
            }
            // Never `-32005`, whatever version the page asked for: we answer
            // our own, so a frozen v0 binary can still serve a future page that
            // lists v1 among its versions.
            return {
              protocolVersion: PROTOCOL_VERSION,
              sessionKey,
              installId,
              identityToken,
              sdk: { name: SDK_NAME, version: SDK_VERSION },
            };
          } catch (e) {
            // The watchdog above is disarmed SYNCHRONOUSLY, which is right for
            // the 7.9s race and fatal once the handler rejects: the peer answers
            // `-32603` and keeps its latch, `handled` is still false so no
            // ladder has claimed the incident, and `onLoadEnd` has already fired
            // for this document and will not fire again. Without the re-arm
            // below the widget is permanently dead with no surface, no event and
            // no way back — for a signed-in install whose token endpoint is
            // down, for a `bytes()` timeout, for a storage rejection. Re-arming
            // hands the incident to the watchdog's one-reload-then-error path,
            // which ends at the Retry screen.
            //
            // `peer.ts` answers every handler rejection `-32603 Internal error`,
            // which the page turns into a silent ~16s wait and then a Retry
            // screen that can never succeed. The one failure with a fix the
            // developer must be told about is an install marked `wasSignedIn`
            // with no identity configured.
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
            // EVERY rejection, not just `IdentityUnavailable`. `refresh()` has
            // one job, so any way it can fail means the same thing to the page,
            // and `-32002` is the answer it wants. Narrowing to the one class
            // would make a future plain `throw` inside identity.ts silently
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
  //
  // Refs, so a scheduled timer's closure always reads the CURRENT
  // counts/generation through `.current` rather than whatever they were when
  // that timer was scheduled. `errorCode`, `dismissed` and `remountKey` are the
  // only pieces that need to trigger a re-render, so they alone are
  // `useState`.
  const [errorCode, setErrorCode] = useState<MentioraErrorCode | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [remountKey, setRemountKey] = useState(0);

  // A logout reloads EVERY mounted widget, inline or Modal-hosted, which is why
  // the subscription lives here and not in the presenter. `runtime`, not
  // `latest.current.runtime`, as the dependency: it is the same object across
  // renders for a given `embedKey`, so this resubscribes only when the embed
  // key changes.
  //
  // It runs the whole of `restartLoad`, not a subset. Without the load boundary
  // `restartLoad` crosses, the fresh page's `initialize` takes `-32600
  // "initialize already completed for this page load"`, that rejection is
  // stamped with the PRE-LOGOUT session key, and a stale `backHeld` plus that
  // still-authorized key let `onHardwareBack` claim back presses into the
  // post-logout page.
  //
  // Reached through a ref (assigned below, once `restartLoad` exists) so this
  // effect depends on `runtime` alone; capturing `restartLoad` directly would
  // resubscribe on every render, since it is rebuilt each time.
  useEffect(() => {
    return runtime.onReload(() => restart.current());
  }, [runtime]);

  // The only reader of `resolveStorage`'s `ephemeral`/`reason`, which the
  // runtime carries. Without persistence every launch mints a new anonymous
  // user and no thread survives, so this is the signal behind "customers keep
  // losing their history".
  //
  // Both a warning and an event, because `__DEV__` is stripped from release
  // bundles and the event is what a release build can see. Once per runtime,
  // i.e. per embed key: the Modal mounts a fresh widget on every `open()`, and
  // one degraded store is one fact.
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
  /** Assigned during render, right after `restartLoad` is defined. The effect
   *  above runs after commit, so it always calls a real function, never this
   *  placeholder. */
  const restart = useRef<() => void>(() => {});

  const generation = useRef(0);
  // Has THIS generation already had its one terminal callback? Shared across
  // all three ladders: an incident that raises two callbacks must advance
  // exactly one counter, not two.
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

  /** A load boundary for OUR OWN bookkeeping, kept in lockstep with the peer's
   *  (`resetLoad`) rather than reusing its counter — that one is for
   *  session-key enforcement, this one for timer staleness. Cancels whatever is
   *  currently ticking; it does NOT arm a new watchdog, for the reason in
   *  `armWatchdog`'s own doc. */
  const advanceGeneration = (): void => {
    peer.resetLoad();
    // A back-button hold belongs to the DOCUMENT that claimed it, and this is
    // where that document stops existing. `peer.resetLoad()` alone only covers
    // the window until the replacement page's own `initialize`: the moment that
    // handshake lands, `peer.sessionKey()` is non-null again and a `backHeld`
    // left over from the previous document is trusted for the rest of the
    // widget's life — every press claimed and forwarded to a page that never
    // asked for the button, with the Modal unable to close and no visible
    // reason why. The page re-claims it with a fresh `mentiora/backHandling` if
    // it still wants it.
    backHeld.current = false;
    // A reset invalidates every in-flight `receive` AND every parked
    // random-bytes resolver. `peer.resetLoad()` is the first half, this is the
    // second: without it a `bytes()` left pending by the dead document holds
    // the single-in-flight slot for the rest of its 2s timeout, and the
    // replacement page's `initialize` is rejected on its very first line — the
    // recovery handshake poisoned by the load boundary meant to produce it.
    randomSource.reset();
    generation.current += 1;
    handled.current = false;
    clearRecoveryTimer();
    clearWatchdogTimer();
  };

  /** Arms the handshake watchdog for the CURRENT generation: 8s for the page to
   *  call `initialize`, starting now. Called from mount, from an allowed
   *  top-frame navigation, from `onLoadEnd`, and from the watchdog's own single
   *  reload (see the file header). A network/crash reload goes through
   *  `advanceGeneration`, so the watchdog ticking for the failed load is
   *  cancelled and not replaced until that reload's `onLoadEnd` arrives. Always
   *  clears any existing timer first, so an extra arm is harmless. */
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
   *  the CURRENT generation. When it fires it advances the generation itself —
   *  never the watchdog's job — and then runs `action`. */
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

  // Mount arms the initial watchdog with no `advanceGeneration` call: a freshly
  // built peer already IS generation 0.
  //
  // From the EFFECT, never the render body. A `setTimeout` in render can only be
  // guarded by a ref that proves "this hooks list has armed once", which says
  // nothing about whether the render committed; a discarded render (a
  // `<Suspense>` sibling suspending, an interrupted transition, StrictMode's
  // double render, which rebuilds the hooks list) leaves a live timer nobody
  // owns, whose closure still holds the real host's `onEvent` — ~16s later the
  // host is handed `{type:'error', code:'handshake_timeout'}` for a widget that
  // handshook fine at t≈0. An effect runs after commit and before any
  // `onLoadEnd`, so the floor is unchanged.
  //
  // Guarded on `peer.sessionKey() === null` so an `<Activity>`/Offscreen
  // re-show, which tears effects down and sets them up again without
  // re-rendering, does not arm a fresh watchdog over a handshake that already
  // landed — that page will never post `initialize` again.
  //
  // The cleanup retires the generation as well as the timers: an `initialize`
  // still awaiting `randomSource.bytes()`, `identity.initial()` or an
  // install-id mint rejects afterwards, passes its own `generation.current ===
  // myGen` check and re-arms the watchdog on a dead instance — a `reload()`
  // into a nulled ref, then a spurious `handshake_timeout` to the host for a
  // chat the user already closed.
  //
  // It clears the refs directly rather than through
  // `clearWatchdogTimer`/`clearRecoveryTimer`, which are rebuilt every render
  // and would force this effect to rerun or fail exhaustive-deps; `useRef`
  // objects are stable, so reading `.current` needs no dependency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; `peer` and `armWatchdog` read refs that are stable for this instance
  useEffect(() => {
    if (peer.sessionKey() === null) armWatchdog();
    return () => {
      if (watchdogTimer.current !== null) clearTimeout(watchdogTimer.current);
      if (recoveryTimer.current !== null) clearTimeout(recoveryTimer.current);
      generation.current += 1;
    };
  }, []);

  /** The platform-uniform re-arm point: a document that has finished loading,
   *  successfully or not, has 8s to speak. See the file header for why a
   *  ladder's own reload must not arm the watchdog instead. */
  const onLoadEnd = (_event: LoadEndEvent): void => {
    armWatchdog();
  };

  /** Suppress the library's own error view and run the load ladder instead: 3
   *  attempts total (this one plus up to 2 more), ~1s then ~2s with full
   *  jitter, then the error surface. */
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

  /** One counter and one cap, shared by both crash callbacks; `recover` is the
   *  only difference — `reload()` on iOS, a remount-key bump on Android, where
   *  a dead renderer must be removed from the hierarchy and never reused. */
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
   *  clean slate, cross a load boundary and make the page try again. Always a
   *  remount (the `key` bump), never a bare `reload()`, because
   *  `renderer_crashed` can be what is showing and Android's own docs say a
   *  killed renderer cannot be reused.
   *
   *  Two callers, deliberately the same function: the error screen's Retry
   *  button, and `runtime.onReload` (i.e. `Mentiora.logout()`). Each line
   *  matters to the logout path in particular:
   *  - `setErrorCode(null)`: otherwise logging out while the error surface is
   *    up leaves "something went wrong" covering a healthy, freshly rotated
   *    page until the user happens to press Retry.
   *  - the three counters: otherwise the post-logout page inherits the previous
   *    user's spent budget and can go straight back to the error surface on its
   *    first hiccup. (A successful `initialize` resets all three anyway, so
   *    this only matters for a post-logout page that itself struggles.)
   *  - `setDismissed(false)`: Retry cannot reach this line while dismissed, and
   *    `dismissed` is cleared nowhere else while the `onReload` subscription
   *    stays live, so leaving it set runs the whole restart against a widget
   *    rendering a blank `<View />` — a fresh watchdog on a WebView nobody
   *    renders, and a `handshake_timeout` to the host ~16s later for a surface
   *    the user had closed. */
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

  /** The only exit from a screen the user reached because the page never drew
   *  its own close control, so it must work when the peer, the runtime and
   *  every ladder above have already given up. Plain component state and the
   *  host's own `onEvent`, nothing else; `dismissed` is checked before
   *  `errorCode` in the render below, so this wins over anything a stray
   *  in-flight timer does afterwards. */
  const onDismiss = (): void => {
    setDismissed(true);
    // The one `onEvent` call that must not be able to take the exit down with
    // it: `setDismissed` above has already committed to stop rendering the
    // WebView whatever the host's callback does next.
    try {
      latest.current.props.onEvent?.({ type: 'close' });
    } catch {
      // Dismiss has already done its one job.
    }
  };

  // -- Insets and Android back -----------------------------------------

  // Computed once — `StatusBar.currentHeight` and the optional peer do not
  // change for the life of the app — and re-sent on every load boundary
  // (mount, and every `onLoadEnd`, which fires for every reload too), since a
  // fresh document has no CSS custom properties of its own until we set them
  // again. `null` (nothing measurable, e.g. iOS with no peer) is itself a
  // valid, memoized answer, so a separate guard ref tracks "computed yet";
  // `!hostInsets.current` alone would recompute, and re-attempt the `require`,
  // on every render.
  const hostInsetsComputed = useRef(false);
  const hostInsets = useRef<HostInsets | null>(null);
  if (!hostInsetsComputed.current) {
    hostInsetsComputed.current = true;
    hostInsets.current = resolveHostInsets();
  }

  // Reads only refs (`webview`, `hostInsets`), so `[]` is genuinely
  // exhaustive rather than a suppressed warning. That keeps one stable identity
  // across renders, which is what lets the mount effect below run exactly once
  // instead of on every render.
  const injectHostInsets = useCallback((): void => {
    const insets = hostInsets.current;
    if (insets) webview.current?.injectJavaScript(hostInsetsScript(insets));
  }, []);

  // Its own effect, not folded into `onLoadEnd` below, because the very first
  // load's `onLoadEnd` has not fired when a test — or a slow real page — first
  // inspects what we sent, and `webview` is only attached once an effect runs,
  // that being the one hook that runs after commit.
  useEffect(() => {
    injectHostInsets();
  }, [injectHostInsets]);

  /** While the page holds the button, `mentiora/back` goes to the page;
   *  otherwise the press is unhandled and the host's own back handling
   *  dismisses the widget, there being no close control of ours to fall back
   *  on.
   *
   *  `backHeld.current` alone is not trusted: it is set from a page message and
   *  never told about a reload/remount that resets the session key out from
   *  under it. `peer.sessionKey() !== null`, re-checked at PRESS TIME, is what
   *  proves a hold is still live — `advanceGeneration`'s `resetLoad()` clears
   *  it synchronously on every reload/remount, so back reverts to unhandled on
   *  the next press even if `backHeld` is stuck `true`. `sendBack()` is the one
   *  host-initiated send with no reply to prove a session exists; the key is
   *  that proof.
   *
   *  `dismissed` and `errorCode !== null` are checked FIRST and independently
   *  of the session key, because the key is no proof that the error surface is
   *  down: the watchdog's give-up branch calls `showError` with no
   *  `advanceGeneration`, so a slow page can still complete `initialize` and
   *  get a live session key after that surface is up — the WebView stays
   *  mounted underneath it so Retry has something to retry. A session-key-only
   *  check would then forward every press to a page hidden behind
   *  `importantForAccessibility="no-hide-descendants"`: handled, invisible, and
   *  with nothing left to release it, the watchdog's re-arm being a no-op while
   *  `handled.current` is `true`. `dismissed` covers the same gap after
   *  Dismiss, which stops rendering the WebView but touches neither `backHeld`
   *  nor the peer, leaving the BackHandler subscription live behind a blank
   *  `<View />`.
   *
   *  `dismissed` is currently redundant — the only way `errorCode` returns to
   *  null is `restartLoad`, which crosses a load boundary and so clears
   *  `backHeld` and the session key — and kept because it is one token wide and
   *  keeps the pair safe if a later change clears the surface without crossing
   *  a boundary. */
  const onHardwareBack = useCallback((): boolean => {
    if (dismissed || errorCode !== null) return false;
    if (backHeld.current && peer.sessionKey() !== null) {
      peer.sendBack();
      return true;
    }
    return false;
  }, [peer, dismissed, errorCode]);

  // `useLayoutEffect`, not `useEffect`. `onHardwareBack` closes over
  // `dismissed`/`errorCode`, and `showError` runs from a timer — a non-discrete
  // lane whose passive effects flush on the scheduler's NEXT task. A press
  // landing in that gap runs the previous closure and, if the page still holds
  // the button, forwards `mentiora/back` to a page sitting under the error
  // surface instead of closing. A layout effect registers in the same commit as
  // the state that changed it, so the gap does not exist.
  useLayoutEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', onHardwareBack);
    // The SAME decision, handed to the Modal's `onRequestClose` too when one is
    // an ancestor, never a second re-derived one. Registering and deregistering
    // here rather than in a separate effect means a fresh `onHardwareBack`
    // closure (`dismissed`/`errorCode` changed) replaces the old registration
    // atomically, and unmount always clears it.
    registerBackPress?.(onHardwareBack);
    // `.remove()` on the subscription `BackHandler.addEventListener` returns —
    // never `BackHandler.removeEventListener`, deleted in RN 0.77, which throws
    // if called. Re-subscribing when `dismissed`/`errorCode` change (both flow
    // into `onHardwareBack`'s identity via its own deps) is fine: `.remove()`
    // on the way out always pairs with the `addEventListener` that produced
    // it.
    return () => {
      subscription.remove();
      registerBackPress?.(null);
    };
  }, [onHardwareBack, registerBackPress]);

  const onMessage = useCallback(
    (event: MessageEvent) => {
      const raw = event.nativeEvent.data;
      // BEFORE the JSON-RPC parser, always: the random reply is not JSON-RPC
      // and would be answered `-32600` by the peer.
      if (randomSource.acceptReply(raw)) return;
      void peer.receive(raw);
    },
    [peer, randomSource],
  );

  // Not `useCallback`: it calls `beginFreshLoad`, which is rebuilt every render
  // anyway, and both close over refs rather than state, so identity does not
  // matter — as for `onError`/`onRenderProcessGone` above.
  const onShouldStartLoadWithRequest = (request: NavigationRequest): boolean => {
    const { url, isTopFrame, navigationType } = request;
    if (isSameOrigin(url, latest.current.props.widgetOrigin)) {
      // A load boundary is an identifiable one: initial mount (a freshly built
      // peer already IS generation 0 with no session key) and an allowed
      // TOP-FRAME navigation, which is a fresh top-level load exactly like
      // mount and so gets its own handshake watchdog. Never a bare
      // `onLoadStart` — Android raises that from `doUpdateVisitedHistory`,
      // which also sees in-page history changes, so resetting there clears the
      // session key mid-document and every later message takes `-32001`. A
      // sub-frame (the custom-block sandbox iframe) is the same document and
      // must not reset anything either.
      //
      // Unless the document did not actually change: `/chat` -> `/chat#thread`
      // raises this callback with `isTopFrame: true` on both platforms, and
      // treating a fragment jump as a boundary drops a live session key and
      // reopens the keyless `initialize` latch while the page and its iframe
      // are still running. The FIRST top-frame request has nothing to compare
      // against and is always a boundary.
      //
      // A `reload` is a boundary whatever the URLs say: iOS surfaces
      // `navigationType: 'reload'` for `location.reload()` and for the
      // library's own `reload()`, and the URL is identical by definition, so
      // the comparison below cannot see it. Android reports `'other'` for
      // everything and never raises this callback for a reload at all, so the
      // check is a no-op there.
      if (isTopFrame) {
        const previous = lastTopUrl.current;
        lastTopUrl.current = url;
        if (previous === null || navigationType === 'reload' || !isSameDocument(previous, url))
          beginFreshLoad();
      }
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
  // WebView — checked first so it wins over anything else, including an error
  // surface a stray in-flight timer sets afterwards.
  if (dismissed) return <View />;

  return (
    <View style={styles.container}>
      <WebView<object>
        // Android's own docs are explicit that a dead renderer must be removed
        // from the hierarchy and destroyed, never reused; `onRenderProcessGone`'s
        // recovery bumps this key to force exactly that.
        key={remountKey}
        ref={webview}
        testID="mentiora-webview"
        style={styles.webview}
        // encodeURIComponent: `embedKey` is customer input and belongs in exactly
        // one path segment.
        //
        // `widgetOrigin` and `embedKey` are FIXED for the life of a widget
        // instance: `key` the component on them to change either. Changing them
        // in place re-renders with a new `source.uri`, and Android never
        // dispatches `onShouldStartLoadWithRequest` for the resulting
        // `setSource` -> `loadUrl()` (`RNCWebViewClient.java` raises it only
        // from `shouldOverrideUrlLoading`), so no load boundary is crossed: the
        // new document's `initialize` takes `-32600` and the widget is blank
        // until the `onLoadEnd`-armed watchdog reloads it 8s later. Documented
        // rather than coded around, since it self-heals and closing the gap
        // needs a device check first.
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
          // A fresh document has none of the previous one's custom properties
          // — re-set them every time a load actually finishes, not just once
          // at mount.
          injectHostInsets();
        }}
        // The overlay below covers this WebView without removing it from the
        // tree, so without this a screen reader can still reach the dead page
        // underneath the one screen that is supposed to be the only way out.
        // Android: hide the whole subtree from TalkBack while the overlay owns
        // the screen.
        importantForAccessibility={errorCode !== null ? 'no-hide-descendants' : 'auto'}
      />
      {/* An overlay, not a swap: the WebView stays mounted underneath, so its
       *  `injectJavaScript`/`reload` stay live for whichever ladder is still
       *  ticking, until Retry or Dismiss actually acts. Retry's own reload is
       *  what makes the page try again; this screen only covers a page that, on
       *  its own, never draws anything at all. */}
      {errorCode !== null && (
        // iOS: tells VoiceOver everything outside this view is not part of
        // the current screen, matching Android's `importantForAccessibility`
        // above on the WebView it is covering.
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
