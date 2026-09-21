/**
 * `Mentiora.open()/close()/logout()` presenting `<MentioraWidget />` over a
 * `Modal` (plan Task 12, design.md §2.7).
 *
 * **The Modal reloads on every open, and that is the decision.** No
 * persistent WebView: `<MentioraHost />` renders nothing at all while closed
 * (`state.visible` false unmounts the whole subtree, not just hides it), so
 * every `Mentiora.open()` mounts a fresh `<MentioraWidget />` and the page
 * resumes the thread from server state — which is what makes messages that
 * arrived while closed appear on reopen.
 *
 * **The mounting decision (fix round 1 — reversed from the original brief).**
 * The original plan took `AppRegistry.setWrapperComponentProvider`, patched
 * at import time, so `open()` would work with nothing customer-mounted. That
 * turned out to be unacceptable for a published library, for two independent
 * reasons, either of which is enough on its own:
 *
 * - `AppRegistry`'s wrapper-provider slot has a setter (`AppRegistryImpl.js:50`)
 *   but no getter anywhere — the current value is a module-local `let`
 *   (`:40`) with no reflection path to it. Patching the setter to "compose"
 *   can only ever see providers registered AFTER the patch; one already
 *   installed before this module imports is invisible, permanently, with no
 *   way to detect the gap at runtime. And the patch itself never restores
 *   the original setter, so an app that captured the un-patched function
 *   before this module loaded keeps calling straight past us regardless.
 * - `runApplication` reads the slot exactly once, at native launch
 *   (`AppRegistryImpl.js:107-108`). A customer whose app requires this SDK
 *   lazily — an inline `require`, `React.lazy`, a dynamic import inside a
 *   screen — has that read already happen before this module ever runs, so
 *   the provider is silently never consulted at all. Two independent ways to
 *   silently do nothing, neither detectable.
 *
 * So: the customer mounts `<MentioraHost />` once, at their app root (above
 * their navigator). `Mentiora.open()` throws a distinct, actionable error if
 * none is currently mounted — counted from RENDER, not from subscribe (see
 * `hostIds` below; fix round 3, Major 5) so it can't false-negative on a host
 * that mounts later in the same commit as its caller.
 *
 * **The back channel is the widget's own decision (fix round 3, Criticals 1
 * and 2).** `onRequestClose` used to read a module-level map (keyed by
 * `embedKey`) written by the widget's `onBackHandling` peer handler, plus a
 * `blocked` ref of its own. Both were wrong: the map's `sendBack()` silently
 * no-ops once a transient reload clears the session key, which
 * `onRequestClose` never checked, leaving the Modal's back button
 * permanently dead after one blip; and keying by `embedKey` let an INLINE
 * widget on the SAME embed key (design.md §3.1's own example app) hijack or
 * erase the Modal's registration. `back-channel.ts` now carries the widget's
 * existing `onHardwareBack` — already `() => boolean`, already correct —
 * registered per WIDGET INSTANCE through an internal context `ModalBody`
 * provides. See `back-channel.ts`'s own header for the rest.
 */
import type React from 'react';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { Modal } from 'react-native';
import type { BackPress } from './back-channel.js';
import { BackChannelContext } from './back-channel.js';
import { MentioraWidget } from './MentioraWidget.js';
import { getRuntime } from './runtime.js';
import type { MentioraConfig, MentioraEvent } from './types.js';

type PresenterState = {
  visible: boolean;
  config: MentioraConfig | null;
  /** Which mounted `<MentioraHost />` (by its own id, below) is the one
   *  allowed to render the Modal — see "two hosts" below. */
  activeHostId: number | null;
};

let state: PresenterState = { visible: false, config: null, activeHostId: null };
const listeners = new Set<() => void>();
/** Hosts currently RENDERED, oldest first — pushed to during RENDER (see
 *  `MentioraHost` below), not during the subscribe effect `registerHost`
 *  runs from. Fix round 3, Major 5: `useSyncExternalStore` subscribes in a
 *  PASSIVE EFFECT, which runs after every component's render in the same
 *  commit has already happened but interleaved with OTHER components' own
 *  effects in tree order — so a host mounted after the screen that calls
 *  `open()` (from its own mount effect) would not have subscribed yet when
 *  that effect ran, and `open()` would reject with "no host mounted" even
 *  though one is three lines below in the same tree. Counting from render
 *  instead means membership is settled before ANY effect in the commit runs,
 *  regardless of JSX sibling order. Caveat accepted deliberately: a host
 *  that renders but never commits leaks an id here, which fails in the
 *  benign direction (`open()` succeeds, nothing ends up rendering) rather
 *  than the noisy false-alarm this replaces.
 *
 *  The invariant this array keeps (fix round 4, Critical 2) is SET
 *  membership, not a push/pop log: an id is added when the host renders AND
 *  re-added, idempotently, on every subscribe (`registerHost`), while a
 *  teardown removes it. Render alone is not enough, because React tears
 *  effects down and sets them up again on the same fiber without re-rendering
 *  (StrictMode, Offscreen, Fast Refresh) — a push that only ever happens at
 *  render is spliced out by the first such cycle and never restored. */
const hostIds: number[] = [];
let nextHostId = 0;

const notify = (): void => {
  for (const fn of listeners) fn();
};

/**
 * Two mounted hosts never render two Modals: the rule is oldest-first — the
 * first host to ever subscribe owns the Modal for as long as it stays
 * mounted; if it unmounts, the next-oldest surviving host (if any) takes
 * over. A customer is only ever expected to mount one of these, so this only
 * matters for the "briefly two during a screen transition" case, and picking
 * a total order rather than "last wins" or "undefined" is what keeps that
 * case from ever showing two Modals, even for one frame.
 */
const registerHost = (id: number, onChange: () => void): (() => void) => {
  listeners.add(onChange);
  // Idempotent re-add, not a second source of truth (fix round 4, Critical 2).
  // Render is what FIRST counts a host (see `hostIds` above, and `MentioraHost`
  // below); this line only restores membership that a previous teardown of
  // this same, still-mounted component removed. React 18/19 StrictMode — the
  // RN and Expo templates' default — mounts effects, tears them down and
  // mounts them again WITHOUT re-rendering, so the render-time push runs once
  // while the splice below runs twice: without this, the id is gone forever
  // and `open()` throws "needs <MentioraHost /> mounted" at a customer whose
  // host is mounted. Same for anything else that recreates effects without a
  // re-render (`<Activity>`/Offscreen, `react-freeze`, Fast Refresh), and for
  // a host that outlives a `__resetPresenter()` and later resubscribes.
  if (!hostIds.includes(id)) hostIds.push(id);
  if (state.activeHostId === null) state = { ...state, activeHostId: id };
  notify();
  return () => {
    listeners.delete(onChange);
    const index = hostIds.indexOf(id);
    if (index >= 0) hostIds.splice(index, 1);
    if (state.activeHostId === id) state = { ...state, activeHostId: hostIds[0] ?? null };
    notify();
  };
};

const getSnapshot = (): PresenterState => state;

export const Mentiora = {
  configure(config: MentioraConfig): void {
    state = { ...state, config };
    notify();
  },
  async open(): Promise<void> {
    // A customer who did neither learns about `configure()` first — it's the
    // more fundamental omission, and the more common first mistake.
    if (!state.config) {
      throw new Error(
        'Mentiora.open() was called before Mentiora.configure(config). Call Mentiora.configure() first.',
      );
    }
    if (hostIds.length === 0) {
      throw new Error(
        'Mentiora.open() needs <MentioraHost /> mounted once at your app root. Add it above your navigator.',
      );
    }
    state = { ...state, visible: true };
    notify();
  },
  /** Not a programming error to call before `configure()`/while already
   *  closed — closing something that was never open is a no-op, not a throw.
   *  Deliberately asymmetric with `logout()` below: there is nothing to undo
   *  here, so a mutation that made this throw too (mirroring `logout()`'s own
   *  guard) would be wrong, not merely redundant. */
  close(): void {
    if (!state.config || !state.visible) return;
    state = { ...state, visible: false };
    notify();
  },
  /** Host state, not view state (design.md §2.4): rotates the install id and
   *  clears the shared identity cache immediately through the runtime.
   *  Reached through `getRuntime`, never through a mounted component — every
   *  mounted `<MentioraWidget />` (inline or Modal-hosted) subscribes to
   *  `runtime.onReload` itself and reloads on its own (`MentioraWidget.tsx`).
   *
   *  Throws before `configure()`, unlike `close()`: a caller that reached
   *  `logout()` has, by definition, a user to sign out, and silently
   *  resolving without rotating anything would strand the PREVIOUS user's
   *  install id and `wasSignedIn` flag in storage for the next person on the
   *  device to inherit — undiagnosable, since nothing here would ever say so
   *  (fix round 3, Major 6). */
  async logout(): Promise<void> {
    if (!state.config) {
      throw new Error(
        'Mentiora.logout() was called before Mentiora.configure(config). Call Mentiora.configure() first.',
      );
    }
    await getRuntime(state.config).logout();
  },
};

/** Tests only (mirrors `runtime.ts`'s `__resetRuntimes`). Unlike an earlier
 *  version of this module, unmounting the last `<MentioraHost />` does NOT
 *  reset `config`/`visible` on its own — under a customer-mounted host that
 *  would be live, not inert: a screen unmount or a Fast Refresh would
 *  silently discard `configure()`, and the next `open()` would throw "call
 *  configure() first" at a customer who already had. Tests reset explicitly
 *  instead — before rendering anything, not with a host still mounted: this
 *  empties `hostIds` and `listeners` outright, and a host that is already
 *  mounted only lands back in `hostIds` if something makes it resubscribe. */
export const __resetPresenter = (): void => {
  state = { visible: false, config: null, activeHostId: null };
  listeners.clear();
  hostIds.length = 0;
  nextHostId = 0;
};

/** The component a host app mounts once, at its app root. */
export function MentioraHost(): React.JSX.Element | null {
  const id = useRef<number | undefined>(undefined);
  if (id.current === undefined) {
    id.current = nextHostId++;
    // Membership in `hostIds` is counted from RENDER (see the array's own
    // doc comment above), guarded the same way `id.current` itself is so a
    // React-internal double-invoke of this render (StrictMode) reuses the
    // same id and pushes exactly once.
    hostIds.push(id.current);
  }
  const hostId = id.current;

  const subscribeThis = useCallback(
    (onChange: () => void): (() => void) => registerHost(hostId, onChange),
    [hostId],
  );
  const snapshot = useSyncExternalStore(subscribeThis, getSnapshot, getSnapshot);

  if (snapshot.activeHostId !== hostId) return null; // another mounted host owns the Modal
  if (!snapshot.visible || !snapshot.config) return null;
  return <ModalBody config={snapshot.config} />;
}

function ModalBody({ config }: { config: MentioraConfig }): React.JSX.Element {
  // Provided to `MentioraWidget` (via `BackChannelContext`) so it can hand us
  // its own `onHardwareBack` — the SAME decision the hardware button uses,
  // by construction, not a re-derived one. A ref, not state: `onRequestClose`
  // needs to read whatever is CURRENTLY registered at press time, and a
  // registration changing (a fresh `dismissed`/`errorCode` closure) has
  // nothing for `ModalBody` itself to re-render over.
  const backPress = useRef<BackPress | null>(null);
  const registerBackPress = useCallback((press: BackPress | null): void => {
    backPress.current = press;
  }, []);

  const onEvent = useCallback(
    (event: MentioraEvent) => {
      // Our own bookkeeping BEFORE the host callback, not after (fix round 3,
      // Major 7): `MentioraWidget`'s own Dismiss path wraps ITS `onEvent` call
      // in try/catch ("the one call that must not be able to take the exit
      // down with it") — calling the host callback first let a host that
      // throws on `{type:'close'}` get swallowed by that same try/catch,
      // skipping `Mentiora.close()` entirely and stranding a `visible={true}`
      // Modal over the blank `<View />` Dismiss just rendered, with no escape
      // on iOS (Android still had `onRequestClose`, only by accident).
      if (event.type === 'close') Mentiora.close();
      config.onEvent?.(event);
    },
    [config],
  );

  // While the page holds the button, this asks the widget's OWN
  // `onHardwareBack` — never a re-derived boolean — whether the press was
  // handled. `onHardwareBack` already checks `dismissed`, `errorCode !==
  // null`, `backHeld`, and `peer.sessionKey() !== null` at press time, so a
  // stale hold left behind by a reload that has since cleared the session
  // key already reads as unhandled — no separate latch needed here.
  const onRequestClose = useCallback((): void => {
    if (backPress.current?.()) return; // handled: stay open
    Mentiora.close();
  }, []);

  return (
    <BackChannelContext.Provider value={registerBackPress}>
      <Modal visible onRequestClose={onRequestClose}>
        <MentioraWidget {...config} onEvent={onEvent} />
      </Modal>
    </BackChannelContext.Provider>
  );
}
