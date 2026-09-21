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
 * none is currently mounted — detected by whether any host is subscribed,
 * never by guessing.
 */
import type React from 'react';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { Modal } from 'react-native';
import { getBackHandler } from './back-hold.js';
import { MentioraWidget } from './MentioraWidget.js';
import { getRuntime } from './runtime.js';
import type { MentioraConfig, MentioraEvent } from './types.js';

type PresenterState = {
  visible: boolean;
  config: MentioraConfig | null;
  /** Bumped by the runtime's `onReload` subscription (logout while the Modal
   *  is open) to force `<MentioraWidget />` to remount with a fresh WebView,
   *  the same "fresh page load" contract `Mentiora.open()` itself gives. */
  reloadKey: number;
  /** Which mounted `<MentioraHost />` (by its own id, below) is the one
   *  allowed to render the Modal — see "two hosts" below. */
  activeHostId: number | null;
};

let state: PresenterState = { visible: false, config: null, reloadKey: 0, activeHostId: null };
const listeners = new Set<() => void>();
/** Mounted host ids, oldest first — a plain array doubles as both "how many
 *  hosts are mounted" (for `open()`'s check) and "who's next" (for the
 *  promotion below). */
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
  hostIds.push(id);
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
    if (listeners.size === 0) {
      throw new Error(
        'Mentiora.open() needs <MentioraHost /> mounted once at your app root. Add it above your navigator.',
      );
    }
    state = { ...state, visible: true };
    notify();
  },
  /** Not a programming error to call before `configure()`/while already
   *  closed — closing something that was never open is a no-op, not a throw. */
  close(): void {
    if (!state.config || !state.visible) return;
    state = { ...state, visible: false };
    notify();
  },
  /** Host state, not view state (design.md §2.4): rotates the install id and
   *  clears the shared identity cache immediately through the runtime, then
   *  notifies whichever widgets are mounted. With the Modal closed and no
   *  inline widget there is nothing to notify, and that is not an error — the
   *  next mount/`open()` initializes with the rotated state. Reached through
   *  `getRuntime`, never through a mounted component. */
  async logout(): Promise<void> {
    if (!state.config) return;
    await getRuntime(state.config).logout();
  },
};

/** Tests only (mirrors `runtime.ts`'s `__resetRuntimes`). Unlike an earlier
 *  version of this module, unmounting the last `<MentioraHost />` does NOT
 *  reset `config`/`visible` on its own — under a customer-mounted host that
 *  would be live, not inert: a screen unmount or a Fast Refresh would
 *  silently discard `configure()`, and the next `open()` would throw "call
 *  configure() first" at a customer who already had. Tests reset explicitly
 *  instead. */
export const __resetPresenter = (): void => {
  state = { visible: false, config: null, reloadKey: 0, activeHostId: null };
  listeners.clear();
  hostIds.length = 0;
  nextHostId = 0;
};

/** The component a host app mounts once, at its app root. */
export function MentioraHost(): React.JSX.Element | null {
  const id = useRef<number | undefined>(undefined);
  if (id.current === undefined) id.current = nextHostId++;
  const hostId = id.current;

  const subscribeThis = useCallback(
    (onChange: () => void): (() => void) => registerHost(hostId, onChange),
    [hostId],
  );
  const snapshot = useSyncExternalStore(subscribeThis, getSnapshot, getSnapshot);

  if (snapshot.activeHostId !== hostId) return null; // another mounted host owns the Modal
  if (!snapshot.visible || !snapshot.config) return null;
  return <ModalBody config={snapshot.config} reloadKey={snapshot.reloadKey} />;
}

function ModalBody({
  config,
  reloadKey,
}: {
  config: MentioraConfig;
  reloadKey: number;
}): React.JSX.Element {
  // Set once a session ever reaches the error surface or asks to close, and
  // never cleared for the life of THIS mount (a fresh key/open cycle is a
  // fresh instance, hence a fresh ref) — mirrors `onHardwareBack`'s own
  // `dismissed || errorCode !== null` guard, which `onRequestClose` needs for
  // the same reason (see the file header on 11c's watchdog give-up branch).
  const blocked = useRef(false);

  useEffect(() => {
    return getRuntime(config).onReload(() => {
      state = { ...state, reloadKey: state.reloadKey + 1 };
      notify();
    });
  }, [config]);

  const onEvent = useCallback(
    (event: MentioraEvent) => {
      config.onEvent?.(event);
      if (event.type === 'error') blocked.current = true;
      // The page asked to close (its own control, or ErrorScreen's Dismiss) —
      // an empty Modal left showing over nothing is not a graceful exit.
      if (event.type === 'close') Mentiora.close();
    },
    [config],
  );

  // Fix round 1: while the page holds the button, this now actually forwards
  // `mentiora/back` (via the widget's own `sendBack`, reached through
  // `back-hold.ts` — a plain boolean here left the page never told a press
  // happened at all, so it could never release the hold: back was dead for
  // the life of the Modal, exactly the trap 11b/11c both exist to close).
  // `blocked` is checked first, same reasoning as `onHardwareBack`'s own
  // `dismissed || errorCode !== null` guard: once the error surface is up (or
  // the page asked to close), a late/stale hold must not keep forwarding.
  const onRequestClose = useCallback((): void => {
    if (!blocked.current) {
      const sendBack = getBackHandler(config.embedKey);
      if (sendBack) {
        sendBack();
        return; // held: stay open, the page now knows a press happened
      }
    }
    Mentiora.close();
  }, [config]);

  return (
    <Modal visible onRequestClose={onRequestClose}>
      <MentioraWidget key={reloadKey} {...config} onEvent={onEvent} />
    </Modal>
  );
}
