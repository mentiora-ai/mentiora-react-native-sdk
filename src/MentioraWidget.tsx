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
 *   reload, which re-arms itself immediately (`beginFreshLoad`) rather than
 *   waiting on `onLoadEnd` first — its contract is "one silent reload, then
 *   an unconditional recheck in 8s", not "whenever this reload happens to
 *   finish". That immediate arm is not the only one: on a real device this
 *   same reload later fires its own `onLoadEnd` too, which re-arms again and
 *   supersedes it. No leak either way — `armWatchdog` clears any existing
 *   timer before setting a new one — and the second arm only ever gives the
 *   page more time to speak than the immediate one alone would, never less.
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
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { BackHandler, Linking, Platform, StatusBar, StyleSheet, View } from 'react-native';
import type { WebViewProps } from 'react-native-webview';
import { WebView } from 'react-native-webview';
import { BackChannelContext } from './back-channel.js';
import { BridgeError, createHostPeer, type HostPeer } from './bridge/peer.js';
import { ErrorCode, PROTOCOL_VERSION } from './bridge/protocol.js';
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
 * Task 11c, design.md §2.7: the page takes `max(env(safe-area-inset-*),
 * --mw-host-inset-*)` and tracks `visualViewport` itself — we never claim
 * `reportsViewport` (no test below or elsewhere injects that string).
 *
 * We set the four `--mw-host-inset-*` custom properties ONLY when we can
 * actually measure something: `react-native-safe-area-context` when
 * present (Expo Go bundles it; `initialWindowMetrics` is filled in by the
 * native module at JS startup, so it works with no `<SafeAreaProvider>`
 * ancestor — this widget cannot assume the host mounted one), else
 * `StatusBar.currentHeight` on Android, where `env()` has no meaningful
 * value in WebView before M136. iOS needs nothing from us: with neither the
 * peer nor an Android fallback to reach for, `resolveHostInsets` returns
 * `null` and nothing is injected at all — never a fabricated `0` passed off
 * as a measurement the page would then trust as a floor.
 */
type HostInsets = { top: number; right: number; bottom: number; left: number };

/**
 * `react-native-safe-area-context` is an optional peer — resolved the way
 * `storage.ts` resolves `@react-native-async-storage/async-storage`: guarded
 * on `typeof require === 'function'` first (a bare `require` is emitted
 * verbatim into the ESM build, where it has no synchronous form at all, and
 * its `ReferenceError` would otherwise be swallowed by the `catch` below as
 * "peer not installed" when the real reason is "this build cannot
 * auto-resolve a peer synchronously at all"), then a try/catch around the
 * require itself for the peer genuinely not being installed.
 */
/** `insets.top/right/bottom/left` are interpolated straight into a CSS
 *  length (`${px}px`) with no further validation downstream — an `undefined`
 *  or non-numeric field from a peer whose shape does not match what we
 *  expect (a different major version, a mocking mistake, anything) would
 *  silently become the token `"undefinedpx"`. That is a syntactically VALID
 *  custom-property value, so nothing throws; the page's own
 *  `max(env(...), var(--mw-host-inset-top))` then fails at computed-value
 *  time and the whole padding declaration using it is dropped, not just the
 *  one side — worse than never having set the property at all. Reject the
 *  measurement outright rather than pass any part of it through. */
const hasValidInsets = (insets: HostInsets): boolean =>
  Number.isFinite(insets.top) &&
  Number.isFinite(insets.right) &&
  Number.isFinite(insets.bottom) &&
  Number.isFinite(insets.left);

const loadSafeAreaInsets = (
  hasRequire: () => boolean = () => typeof require === 'function',
  // A second injectable seam (not just `hasRequire`) so the WIRING of
  // `hasValidInsets` into this function — not only the predicate in
  // isolation — is directly testable: a mutation deleting the
  // `hasValidInsets` call here is invisible to a test that only calls
  // `hasValidInsets` itself.
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

/** Test-only: exercises `loadSafeAreaInsets`'s OWN wiring of the malformed-
 *  measurement guard (see `hasValidInsets` above) via its `requireModule`
 *  seam, distinct from `__hasValidInsetsForTest`, which only proves the
 *  predicate itself. */
export const __loadSafeAreaInsetsForTest = loadSafeAreaInsets;

/**
 * `load` is an injectable seam (mirrors `storage.ts`'s `resolveStorage`
 * accepting `load`, and `random.ts`'s `globalCrypto`) so the Android
 * fallback and the "nothing measurable" branch are each directly testable
 * without fighting Jest's module cache for a peer that either is or is not
 * actually installed in a given run — `__resolveHostInsetsForTest` below is
 * the test-only hook onto it. Production always calls this with no
 * arguments, i.e. the real `loadSafeAreaInsets`.
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

/** Test-only (mirrors `runtime.ts`'s `__resetRuntimes`): exercises the
 *  branch logic in `resolveHostInsets` directly. */
export const __resolveHostInsetsForTest = resolveHostInsets;

/** Test-only: the malformed-measurement guard lives inside `loadSafeAreaInsets`
 *  (never inside `resolveHostInsets`, which trusts whatever `load()` returns),
 *  so it needs its own direct hook rather than being reachable through
 *  `__resolveHostInsetsForTest`'s injected `load`. */
export const __hasValidInsetsForTest = hasValidInsets;

/**
 * A plain style write, not a bridge message — `window.mentioraHost.receive`
 * does not apply here — but it keeps `injection`'s own two invariants:
 * every interpolated value goes through `JSON.stringify`, and the script
 * ends in `true;`.
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

/** Which runtimes have already reported degraded storage (§2.4). Keyed on the
 *  runtime object, which `getRuntime` memoises per embed key and never
 *  rebuilds, so this is "once per embed key" without a registry to clear — a
 *  `__resetRuntimes()` produces fresh objects and the old entries fall out of
 *  the WeakSet with them. */
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

  // Task 11c: does the page currently hold the hardware back button? Read
  // fresh on every press (see `onHardwareBack` below) rather than trusted at
  // face value — `peer.sessionKey()` is what actually proves a hold is still
  // live, since a reload/remount resets it synchronously and this ref alone
  // does not.
  const backHeld = useRef(false);

  /** The top-frame URL this WebView last committed to, so a fragment-only
   *  navigation can be told apart from a real one (external review, M1). A
   *  ref, not state: it is read and written inside a navigation callback and
   *  must never schedule a render. */
  const lastTopUrl = useRef<string | null>(null);

  // Task 12 (fix round 3): non-null only when a `<MentioraHost />`'s Modal is
  // an ancestor — `back-channel.ts`'s own header has the full reasoning. An
  // inline widget with no such ancestor gets `null` here and this is a no-op
  // everywhere below; it keeps using `BackHandler` exactly as before.
  const registerBackPress = useContext(BackChannelContext);

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
          clearWatchdogTimer();
          // Captured before the first await, so a handler whose document has
          // since been replaced mutates nothing — the same rule `peer.receive`
          // keeps for its own sends (§2.2: "work from the old generation may
          // neither mutate state nor send").
          const myGen = generation.current;
          try {
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
            // A page that gets THIS FAR is proof that the TRANSPORT works, so a
            // transient blip long ago does not count against a page that has
            // since loaded cleanly — the network counter and the watchdog
            // counter reset. Reset here, on the success path, and never at the
            // top of the handler: a handler about to reject has proved nothing,
            // and zeroing the watchdog's own counter on the way to failing
            // turns the catch below into an unbounded reload loop rather than
            // the one-reload-then-error path it hands the incident to.
            //
            // `crashFailures` deliberately does NOT reset (branch review, M1).
            // A handshake is not proof the renderer will survive, and §2.5's
            // bound exists for `react-native-webview`#1767 — a page that
            // crashes deterministically. Such a page boots fine and dies later,
            // when it renders the thread, so it would clear its own crash
            // budget on the way past on every cycle and the bound would not
            // exist for exactly the page it was written for: an unbounded
            // remount-plus-full-page-load loop, forever, on battery. `Retry`
            // (`restartLoad`) is the explicit way to buy a fresh crash budget.
            if (generation.current === myGen) {
              networkFailures.current = 0;
              handshakeTimeouts.current = 0;
            }
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
          } catch (e) {
            // Branch review, C2. The watchdog above is disarmed SYNCHRONOUSLY —
            // correct for the 7.9s race it was written for, fatal when the
            // handler then rejects: the peer answers `-32603` and keeps its
            // latch (so a page that retries `initialize` gets `-32600`),
            // `handled` is still false so no ladder has claimed the incident,
            // and nothing re-arms the watchdog because `onLoadEnd` already
            // fired for this document and will not fire again. That leaves the
            // widget permanently dead with no surface, no event and no way
            // back — for exactly the case §2.3 names (a signed-in install whose
            // token endpoint is down, where the handshake MUST fail into §2.9's
            // Retry screen rather than answer without a token), and equally for
            // a `bytes()` timeout (§2.1) or a storage rejection. Re-arming hands
            // the incident to the watchdog's own one-reload-then-error path,
            // which ends at that screen.
            if (generation.current === myGen) armWatchdog();
            throw e;
          }
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

  // Task 12 (fix round 3, Major 8): design.md §2.4's "logout() ... reloads
  // whichever widgets are mounted" applies to EVERY mounted widget, inline or
  // Modal-hosted — subscribing HERE, not in the presenter, is what covers
  // both. `runtime` (not `latest.current.runtime`) as the dependency: it's
  // the SAME object across renders for a given `embedKey` (`getRuntime`
  // memoises per key and only swaps `runtime.identity` in place), so this
  // resubscribes only if the embed key itself changes, never on every render.
  //
  // A logout is THE SAME EVENT Retry is — a user-initiated fresh start for
  // this widget — so it runs the same `restartLoad` (fix round 5), not a
  // hand-rolled subset of it. Fix round 4 gave this path the load boundary it
  // was missing (Critical 1: without `peer.resetLoad()` the fresh page's
  // `initialize` takes `-32600 "initialize already completed for this page
  // load"`, that rejection is stamped with the PRE-LOGOUT session key, and a
  // stale `backHeld` plus that still-authorized key let `onHardwareBack`
  // claim back presses into the post-logout page); round 5 gave it the other
  // two things Retry does, for the same reason — see `restartLoad` below.
  //
  // Reached through a ref (declared here, assigned below once `restartLoad`
  // exists) rather than captured directly, so this effect keeps depending on
  // `runtime` alone — a plain capture would make `restartLoad`, rebuilt every
  // render, a dependency and resubscribe the reload listener on every render.
  useEffect(() => {
    return runtime.onReload(() => restart.current());
  }, [runtime]);

  // design.md §2.4, the half nothing implemented (branch review, M2):
  // `resolveStorage` has always computed `ephemeral`/`reason` and the runtime
  // has always carried them, but no caller read either, so the SDK fell back
  // to in-memory storage in silence. Without persistence every launch mints a
  // new anonymous user and no thread survives, which is a support ticket
  // ("customers keep losing their history") with no signal attached.
  //
  // Both halves, because `__DEV__` is stripped from release bundles: a warning
  // alone makes this invisible exactly where it costs money, so the event is
  // what a release build can see. Once per runtime — i.e. per embed key —
  // since the Modal mounts a fresh widget on every `open()` and one degraded
  // store is one fact, not one per presentation.
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
  /** Assigned during render, further down, right after `restartLoad` is
   *  defined — the effect above runs after commit, so it always calls a real
   *  function, never this placeholder. */
  const restart = useRef<() => void>(() => {});

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
    // A back-button hold belongs to the DOCUMENT that claimed it, and this is
    // the point where that document stops existing. `peer.resetLoad()` alone
    // only covers the window between here and the replacement page's own
    // `initialize`: the moment that handshake lands, `peer.sessionKey()` is
    // non-null again and a `backHeld` left over from the previous document
    // would be trusted for the rest of the widget's life — every press
    // claimed and forwarded to a page that never asked for the button, with
    // the Modal unable to close and no visible reason why (branch review,
    // C1). The page re-claims it with a fresh `mentiora/backHandling` if it
    // still wants it.
    backHeld.current = false;
    // design.md §2.2, verbatim: "A reset invalidates every in-flight `receive`
    // AND every parked random-bytes resolver." `peer.resetLoad()` is the first
    // half; this is the second. Without it a `bytes()` left pending by the
    // dead document holds the single-in-flight slot for the rest of its 2 s
    // timeout, and the replacement page's `initialize` is rejected on its very
    // first line — the recovery handshake poisoned by the load boundary that
    // was supposed to produce it (branch review, C3).
    randomSource.reset();
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
   *  self-triggered reload, which re-arms itself immediately rather than
   *  waiting on that reload's own `onLoadEnd` first — its contract is "one
   *  silent reload, then an unconditional recheck in 8s". That immediate arm
   *  is not the last word: the same reload's own `onLoadEnd`, once it fires,
   *  re-arms again and supersedes it, harmlessly (this function always
   *  clears any existing timer first) and only ever more patiently, never
   *  less. A network/crash reload still goes through `advanceGeneration`, so
   *  the watchdog that was ticking for the load that just failed is
   *  cancelled — just not replaced until that reload's own `onLoadEnd`
   *  arrives. */
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
   *  a remount is correct for every code, not just that one.
   *
   *  Two callers, deliberately the same function (fix round 5): the error
   *  screen's Retry button, and `runtime.onReload` (i.e. `Mentiora.logout()`).
   *  A logout is at least as much a fresh start as Retry — a different user,
   *  a rotated install id, a page loaded from scratch — so every piece of
   *  this applies to it:
   *  - `setErrorCode(null)`: without it, logging out while the error surface
   *    is up leaves "something went wrong" covering a healthy, freshly
   *    rotated page until the user happens to press Retry, which is the one
   *    control that looks like the only way forward on a page that is
   *    already fine. That was the user-visible bug this round fixed.
   *  - the three counters: leaving them would be a half fresh start — the
   *    post-logout page would inherit the previous user's spent budget and
   *    could go straight back to the error surface on its first hiccup, with
   *    no silent recovery, which is precisely the state the line above just
   *    cleared. (A successful `initialize` resets all three anyway, so this
   *    only ever matters for a post-logout page that itself struggles —
   *    exactly the case where inheriting is worst.)
   *  - `setDismissed(false)` (re-review, N5): Retry cannot reach this line
   *    while dismissed (the button it lives on is not rendered), so this only
   *    ever affects the logout path — where leaving it set made the "fresh
   *    start" a fiction. `dismissed` is never cleared anywhere else, but the
   *    `onReload` subscription stays live, so a logout ran the whole restart
   *    against a widget still rendering a blank `<View />`: a remount key
   *    bump and a fresh watchdog on a WebView nobody renders, and an
   *    `{type:'error', code:'handshake_timeout'}` handed to the host ~16s
   *    later for a surface the user had closed and that could never come
   *    back. Either the restart is real or it should not run; an inline
   *    widget is still in the host's tree, and a logout is a different user,
   *    so making it real is the answer consistent with everything above. */
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

  // -- 11c: insets and Android back ------------------------------------

  // Computed once — `StatusBar.currentHeight` and the optional peer do not
  // change for the life of the app — and re-sent on every load boundary
  // (mount, and every `onLoadEnd`, which fires for every reload too), since
  // a fresh document has no CSS custom properties of its own until we set
  // them again. `null` (nothing measurable, e.g. iOS with no peer) is itself
  // a valid, memoized answer, so a separate guard ref tracks "computed yet",
  // never `!hostInsets.current` alone — that would recompute (and re-attempt
  // the `require`) on every render for exactly the hosts where it matters
  // least to get wrong.
  const hostInsetsComputed = useRef(false);
  const hostInsets = useRef<HostInsets | null>(null);
  if (!hostInsetsComputed.current) {
    hostInsetsComputed.current = true;
    hostInsets.current = resolveHostInsets();
  }

  // Reads only refs (`webview`, `hostInsets`), so `[]` is genuinely
  // exhaustive, not a suppressed warning — this keeps one stable identity
  // across renders, which is what lets the mount effect below run exactly
  // once instead of on every render.
  const injectHostInsets = useCallback((): void => {
    const insets = hostInsets.current;
    if (insets) webview.current?.injectJavaScript(hostInsetsScript(insets));
  }, []);

  // Mount-time injection is its own effect (not folded into `onLoadEnd`
  // below) because the very first load's `onLoadEnd` has not fired yet when
  // a test — or a slow real page — first inspects what we sent; `webview`
  // is only attached once this runs, an effect being the one hook that runs
  // after commit.
  useEffect(() => {
    injectHostInsets();
  }, [injectHostInsets]);

  /** design.md: "Either path dismisses only when the page has released the
   *  button ... While the page holds it, `mentiora/back` goes to the page."
   *  Default (nothing ever claimed, or already released): unhandled — the
   *  host's own back/navigation handling dismisses the widget, since the
   *  page draws no close control of its own to fall back on here.
   *
   *  `backHeld.current` alone is not trusted: it is set from a page message
   *  and never told about a reload/remount that resets the session key out
   *  from under it (11b's ladders do this on their own timetable, not
   *  ours). `peer.sessionKey() !== null`, re-checked at PRESS TIME (not a
   *  boolean read once), is what actually proves a hold is still live:
   *  `resetLoad()` (11b's `advanceGeneration`) clears it synchronously on
   *  every reload/remount, so the moment that has happened, back reverts to
   *  unhandled on the very next press even if `backHeld` itself is still
   *  stuck `true` — no proof-of-life round trip needed, because the session
   *  key IS the proof. `sendBack()` is otherwise the one host-initiated
   *  send with no such proof (every other send here is a reply); this is
   *  what makes it safe: we only ever call it, and only ever claim the
   *  press as handled, once a session exists in the CURRENT generation.
   *
   *  `dismissed` and `errorCode !== null` are checked FIRST and independently
   *  of the session key, because the session key is NOT proof that the
   *  error surface isn't showing. It is tempting to think it is — 11b resets
   *  every ladder's counter/timer on a successful `initialize`, so the
   *  network and crash ladders can only reach their cap on a generation that
   *  never had a live session — but the handshake watchdog's own give-up
   *  branch (`armWatchdog`'s `else { showError('handshake_timeout') }`) is
   *  the exception: it calls `showError` directly, with NO `advanceGeneration`
   *  of its own, so `peer`'s `initializeLatch` and session key are untouched.
   *  A slow page — a cold start past two 8s watchdog cycles is not exotic —
   *  can still complete `initialize` and get a live session key AFTER that
   *  error surface is already up, since the WebView deliberately stays
   *  mounted underneath it for exactly this reason (so Retry has something
   *  to retry). If that late page then claims the button, a session-key-only
   *  check would forward every later back press to a page hidden behind
   *  `importantForAccessibility="no-hide-descendants"` — handled, but
   *  invisible, with nothing left to ever release it (the watchdog's
   *  re-arm no-ops: `handled.current` is still `true` for this generation).
   *  That is the exact trap this screen exists to prevent, reached through
   *  the one path that does not reset the session key. `dismissed` covers
   *  the same gap once Retry/Dismiss are pressed: Dismiss stops rendering
   *  the WebView but does not touch `backHeld` or the peer, so without this
   *  check a page that claimed the button before a late handshake would
   *  leave the BackHandler subscription (still live; only the WebView is
   *  unmounted) intercepting every press behind a blank `<View />`.
   *
   *  `dismissed` is redundant AS OF C1 and kept deliberately: the only way
   *  `errorCode` goes back to null is `restartLoad`, which now runs
   *  `advanceGeneration` and so clears `backHeld` and the session key — so no
   *  reachable state has `dismissed` true, `errorCode` null and a live hold
   *  at once, and no non-vacuous test can distinguish the two checks. It
   *  stays because it is one token wide and it is what keeps the pair safe if
   *  a later change clears the surface without crossing a load boundary. */
  const onHardwareBack = useCallback((): boolean => {
    if (dismissed || errorCode !== null) return false;
    if (backHeld.current && peer.sessionKey() !== null) {
      peer.sendBack();
      return true;
    }
    return false;
  }, [peer, dismissed, errorCode]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', onHardwareBack);
    // Task 12 (fix round 3): the SAME decision, handed to the Modal's
    // `onRequestClose` too, when one is an ancestor — never a second,
    // re-derived one. Registering/deregistering here (not a separate effect)
    // means a fresh `onHardwareBack` closure (`dismissed`/`errorCode` changed)
    // replaces the old registration atomically, and unmount always clears it.
    registerBackPress?.(onHardwareBack);
    // `.remove()` on the subscription BackHandler.addEventListener returns —
    // never `BackHandler.removeEventListener`, deleted in RN 0.77, which
    // throws if called. Re-subscribing when `dismissed`/`errorCode` change
    // (both flow into `onHardwareBack`'s identity via its own deps) is fine:
    // `.remove()` on the way out always pairs with the `addEventListener`
    // that produced it.
    return () => {
      subscription.remove();
      registerBackPress?.(null);
    };
  }, [onHardwareBack, registerBackPress]);

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
    const { url, isTopFrame, navigationType } = request;
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
      //
      // Unless the document did not actually change: `/chat` -> `/chat#thread`
      // raises this callback with `isTopFrame: true` on both platforms, and
      // treating a fragment jump as a boundary drops a live session key and
      // reopens the keyless `initialize` latch while the page and its iframe
      // are still running — every later page call then takes -32001 and the
      // watchdog reloads a healthy page (external review, M1). The FIRST
      // top-frame request has nothing to compare against and is always a
      // boundary, exactly as before.
      //
      // A `reload` is a boundary whatever the URLs say (re-review, F1): iOS
      // surfaces `navigationType: 'reload'` for `location.reload()` and for the
      // library's own `reload()`, and the URL is identical by definition, so
      // the comparison below cannot see it. Android reports `'other'` for
      // everything and never raises this callback for a reload at all, so this
      // is a no-op there.
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
        onLoadEnd={(event) => {
          onLoadEnd(event);
          // A fresh document (this reload's own) has none of the previous
          // one's custom properties — re-set them every time a load
          // actually finishes, not just once at mount (11c).
          injectHostInsets();
        }}
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
