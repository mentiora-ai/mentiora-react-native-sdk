/**
 * `Mentiora.open()/close()/logout()` presenting `<MentioraWidget />` over a
 * `Modal`. Closed unmounts the subtree, so every `open()` mounts a fresh
 * widget that resumes the thread from server state.
 * `AppRegistry.setWrapperComponentProvider` cannot replace the customer's own
 * `<MentioraHost />`: the slot has a setter and no getter
 * (`AppRegistryImpl.js:50`), and `runApplication` reads it once at launch.
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
  /** Which mounted host may render the Modal — see `registerHost`. */
  activeHostId: number | null;
};

let state: PresenterState = { visible: false, config: null, activeHostId: null };
const listeners = new Set<() => void>();
/** Hosts in the tree, oldest first — added from `MentioraHost`'s layout effect,
 *  which runs before any passive effect in the same commit, so an `open()` from
 *  a sibling's mount effect cannot read a mounting host as absent. Set
 *  membership, not a push/pop log: a StrictMode teardown must not deregister a
 *  host that is still mounted. */
const hostIds: number[] = [];
/** Hosts with a live store subscription, oldest first. Ownership is picked from
 *  here, not `hostIds`, so the owner is one that will actually be notified of
 *  the state change it is handed. */
const subscribedIds: number[] = [];
let nextHostId = 0;

const notify = (): void => {
  for (const fn of listeners) fn();
};

/** Oldest-first ownership: two hosts briefly mounted across a screen transition
 *  never show two Modals for even one frame, and on unmount the next-oldest
 *  subscribed host takes over. */
const registerHost = (id: number, onChange: () => void): (() => void) => {
  listeners.add(onChange);
  // Idempotent re-add: StrictMode, Offscreen and Fast Refresh re-run effects
  // without re-rendering, so without this the layout effect's teardown loses the
  // id for good and `open()` throws at a customer whose host is mounted.
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
    // Config first: the more fundamental omission.
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
  /** No-op when never configured or already closed — nothing to undo.
   *  Deliberately asymmetric with `logout()`, which throws. */
  close(): void {
    if (!state.config || !state.visible) return;
    state = { ...state, visible: false };
    notify();
  },
  /** Rotates the install id and clears the shared identity cache through the
   *  runtime; every mounted widget reloads via `runtime.onReload`. Throws before
   *  `configure()`, unlike `close()`: resolving without rotating strands the
   *  previous user's install id and `wasSignedIn` flag for the next person. */
  async logout(): Promise<void> {
    if (!state.config) {
      throw new Error(
        'Mentiora.logout() was called before Mentiora.configure(config). Call Mentiora.configure() first.',
      );
    }
    await getRuntime(state.config).logout();
  },
};

/** Tests only. Unmounting the last host deliberately does NOT reset
 *  `config`/`visible`: a screen unmount or Fast Refresh would discard
 *  `configure()`. Call before rendering anything — it empties `hostIds` and
 *  `listeners`, and a mounted host returns only if it resubscribes. */
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

  // Layout phase: early enough for a same-commit `open()` to see this host, late
  // enough that a render which never commits never counts. Idempotent.
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
  // A ref, not state: `onRequestClose` reads whatever is registered at press
  // time, and a changed registration has nothing to re-render over.
  const backPress = useRef<BackPress | null>(null);
  const registerBackPress = useCallback((press: BackPress | null): void => {
    backPress.current = press;
  }, []);

  const onEvent = useCallback(
    (event: MentioraEvent) => {
      // Our own bookkeeping BEFORE the host callback: the widget's Dismiss path
      // try/catches its own `onEvent`, so a host throwing on `{type:'close'}`
      // would skip `Mentiora.close()` and strand a Modal over a blank `<View />`.
      if (event.type === 'close') Mentiora.close();
      config.onEvent?.(event);
    },
    [config],
  );

  // Asks the widget's own `onHardwareBack`, which re-checks `dismissed`,
  // `errorCode`, `backHeld` and `peer.sessionKey()` at press time.
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
