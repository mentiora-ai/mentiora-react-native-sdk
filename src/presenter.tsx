/**
 * `Mentiora.open()/close()/logout()` presenting `<MentioraWidget />` over a
 * `Modal`.
 *
 * The Modal reloads on every open, by design. There is no persistent WebView:
 * `<MentioraHost />` renders nothing while closed (`state.visible` false
 * unmounts the whole subtree rather than hiding it), so every
 * `Mentiora.open()` mounts a fresh `<MentioraWidget />` and the page resumes
 * the thread from server state — which is what makes messages that arrived
 * while closed appear on reopen.
 *
 * The customer mounts `<MentioraHost />` once, at their app root above their
 * navigator, and `Mentiora.open()` throws a distinct, actionable error if none
 * is mounted. `AppRegistry.setWrapperComponentProvider`, patched at import
 * time, cannot replace that mount, for two independent reasons:
 *
 * - The wrapper-provider slot has a setter (`AppRegistryImpl.js:50`) and no
 *   getter anywhere — the value is a module-local `let` (`:40`) with no
 *   reflection path to it. A setter patched to "compose" sees only providers
 *   registered after the patch, and it never restores the original, so an app
 *   holding the un-patched function calls straight past it.
 * - `runApplication` reads the slot exactly once, at native launch
 *   (`AppRegistryImpl.js:107-108`). An app that requires this SDK lazily — an
 *   inline `require`, `React.lazy`, a dynamic import inside a screen — has
 *   that read already behind it, so the provider is never consulted.
 *
 * Host presence is counted from the layout phase, not from subscribe (see
 * `hostIds` below), so `open()` cannot false-negative on a host that mounts
 * later in the same commit as its caller.
 *
 * `onRequestClose` asks the widget's own `onHardwareBack` through
 * `back-channel.ts` rather than re-deriving the decision here; that file's
 * header has the reasoning.
 */
import type React from 'react';
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { Modal } from 'react-native';
import type { BackPress } from './back-channel.js';
import { BackChannelContext } from './back-channel.js';
import { MentioraWidget } from './MentioraWidget.js';
import { getRuntime } from './runtime.js';
import type { MentioraConfig, MentioraEvent } from './types.js';

type PresenterState = {
  visible: boolean;
  config: MentioraConfig | null;
  /** Which mounted `<MentioraHost />` (by its own id) may render the Modal —
   *  see `registerHost`. */
  activeHostId: number | null;
};

let state: PresenterState = { visible: false, config: null, activeHostId: null };
const listeners = new Set<() => void>();
/** Hosts currently IN THE TREE, oldest first — written from `MentioraHost`'s
 *  `useLayoutEffect`, never from its render body.
 *
 *  React runs every layout effect in a commit before any passive effect in it,
 *  and `useSyncExternalStore` subscribes in a passive effect. Counting from the
 *  layout phase therefore means a host mounted after the screen whose own mount
 *  effect calls `open()` is already a member when that effect runs, whatever
 *  the JSX sibling order, while a render that never commits never counts.
 *  Counting from render would include discarded renders, and since `open()`
 *  sets `visible: true` with nothing to clear it, the next host to commit would
 *  pop the Modal with no `open()` behind it. Accepted cost: an `open()` issued
 *  from a customer's own `useLayoutEffect` is sibling-order dependent.
 *
 *  This holds SET membership, not a push/pop log: the layout effect adds an id,
 *  `registerHost` re-adds it idempotently on every subscribe, and a teardown
 *  removes it. React tears effects down and sets them up again on the same
 *  fiber without re-rendering (StrictMode, Offscreen, Fast Refresh), so a
 *  one-time add is spliced out by the first such cycle and never restored. */
const hostIds: number[] = [];
/** Hosts with a live store subscription, oldest first — written only by
 *  `registerHost` and its teardown.
 *
 *  Ownership is picked from here rather than from `hostIds` so it can only
 *  name a host that is subscribed, and so will actually be notified of the
 *  state change it is being handed. `hostIds` answers the different question
 *  "is a host in the tree?", and is populated one phase earlier so a
 *  same-commit `open()` cannot read a mounting host as absent. */
const subscribedIds: number[] = [];
let nextHostId = 0;

const notify = (): void => {
  for (const fn of listeners) fn();
};

/**
 * Two mounted hosts never render two Modals: oldest-first — the first host to
 * subscribe owns the Modal while it stays mounted, and on unmount the
 * next-oldest surviving host takes over. Only one host is ever expected, so
 * this matters for the "briefly two during a screen transition" case, where a
 * total order rather than "last wins" is what keeps two Modals from showing
 * even for one frame.
 */
const registerHost = (id: number, onChange: () => void): (() => void) => {
  listeners.add(onChange);
  // Idempotent re-add, not a second source of truth: the layout effect is what
  // FIRST counts a host, and this only restores membership a previous teardown
  // of the same, still-mounted component removed. StrictMode — the RN and Expo
  // template default — mounts effects, tears them down and mounts them again
  // WITHOUT re-rendering, so without this line the id is gone for good and
  // `open()` throws "needs <MentioraHost /> mounted" at a customer whose host
  // is mounted. Same for `<Activity>`/Offscreen, `react-freeze` and Fast
  // Refresh, and for a host that outlives a `__resetPresenter()`.
  if (!hostIds.includes(id)) hostIds.push(id);
  if (!subscribedIds.includes(id)) subscribedIds.push(id);
  if (state.activeHostId === null) state = { ...state, activeHostId: id };
  notify();
  return () => {
    listeners.delete(onChange);
    const index = hostIds.indexOf(id);
    if (index >= 0) hostIds.splice(index, 1);
    const subscribed = subscribedIds.indexOf(id);
    if (subscribed >= 0) subscribedIds.splice(subscribed, 1);
    // From `subscribedIds`, never `hostIds` — see that array's own note.
    if (state.activeHostId === id) state = { ...state, activeHostId: subscribedIds[0] ?? null };
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
    // A customer who did neither is told about `configure()` first: it is the
    // more fundamental omission.
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
  /** Closing something that was never open is a no-op, not a throw — calling
   *  this before `configure()` or while already closed is not an error.
   *  Deliberately asymmetric with `logout()` below, which does throw: there is
   *  nothing to undo here. */
  close(): void {
    if (!state.config || !state.visible) return;
    state = { ...state, visible: false };
    notify();
  },
  /** Host state, not view state: rotates the install id and clears the shared
   *  identity cache immediately through the runtime. Reached through
   *  `getRuntime`, never through a mounted component — every mounted
   *  `<MentioraWidget />`, inline or Modal-hosted, subscribes to
   *  `runtime.onReload` and reloads itself.
   *
   *  Throws before `configure()`, unlike `close()`: a caller that reached
   *  `logout()` has a user to sign out, and resolving without rotating
   *  anything strands the previous user's install id and `wasSignedIn` flag in
   *  storage for the next person on the device to inherit, with nothing
   *  anywhere reporting it. */
  async logout(): Promise<void> {
    if (!state.config) {
      throw new Error(
        'Mentiora.logout() was called before Mentiora.configure(config). Call Mentiora.configure() first.',
      );
    }
    await getRuntime(state.config).logout();
  },
};

/** Tests only (mirrors `runtime.ts`'s `__resetRuntimes`). Unmounting the last
 *  `<MentioraHost />` deliberately does NOT reset `config`/`visible` on its
 *  own: under a customer-mounted host, a screen unmount or a Fast Refresh
 *  would discard `configure()`, and the next `open()` would throw "call
 *  configure() first" at a customer who already had. Call this before
 *  rendering anything, never with a host still mounted — it empties `hostIds`
 *  and `listeners` outright, and an already-mounted host lands back in
 *  `hostIds` only if something makes it resubscribe. */
export const __resetPresenter = (): void => {
  state = { visible: false, config: null, activeHostId: null };
  listeners.clear();
  hostIds.length = 0;
  subscribedIds.length = 0;
  nextHostId = 0;
};

/** The component a host app mounts once, at its app root. */
export function MentioraHost(): React.JSX.Element | null {
  const id = useRef<number | undefined>(undefined);
  if (id.current === undefined) id.current = nextHostId++;
  const hostId = id.current;

  // Membership in `hostIds` is counted from the LAYOUT phase (see that array):
  // early enough that a same-commit `open()` from any passive effect sees this
  // host, late enough that a render which never commits never counts.
  // Idempotent by construction, so StrictMode's mount/teardown/mount of
  // effects is a no-op.
  useLayoutEffect(() => {
    if (!hostIds.includes(hostId)) hostIds.push(hostId);
    return () => {
      const index = hostIds.indexOf(hostId);
      if (index >= 0) hostIds.splice(index, 1);
    };
  }, [hostId]);

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
  // Provided to `MentioraWidget` via `BackChannelContext` so it can hand us
  // its own `onHardwareBack` — the same decision the hardware button uses, by
  // construction. A ref, not state: `onRequestClose` reads whatever is
  // registered at press time, and a changed registration (a fresh
  // `dismissed`/`errorCode` closure) has nothing for `ModalBody` to re-render
  // over.
  const backPress = useRef<BackPress | null>(null);
  const registerBackPress = useCallback((press: BackPress | null): void => {
    backPress.current = press;
  }, []);

  const onEvent = useCallback(
    (event: MentioraEvent) => {
      // Our own bookkeeping BEFORE the host callback: `MentioraWidget`'s
      // Dismiss path wraps its own `onEvent` call in try/catch, so a host that
      // throws on `{type:'close'}` would be swallowed there, skipping
      // `Mentiora.close()` and stranding a `visible={true}` Modal over the
      // blank `<View />` Dismiss just rendered, with no escape on iOS.
      if (event.type === 'close') Mentiora.close();
      config.onEvent?.(event);
    },
    [config],
  );

  // While the page holds the button, this asks the widget's own
  // `onHardwareBack` whether the press was handled. That function already
  // checks `dismissed`, `errorCode !== null`, `backHeld` and
  // `peer.sessionKey() !== null` at press time, so a hold left over from a
  // reload that has since cleared the session key reads as unhandled with no
  // separate latch here.
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
