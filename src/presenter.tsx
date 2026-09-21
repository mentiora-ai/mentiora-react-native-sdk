/**
 * `Mentiora.open()/close()/logout()` presenting `<MentioraWidget />` over a
 * `Modal` (plan Task 12, design.md §2.7).
 *
 * **The Modal reloads on every open, and that is the decision.** No
 * persistent WebView: `<MentioraPresenterHost />` renders nothing at all
 * while closed (`state.visible` false unmounts the whole subtree, not just
 * hides it), so every `Mentiora.open()` mounts a fresh `<MentioraWidget />`
 * and the page resumes the thread from server state — which is what makes
 * messages that arrived while closed appear on reopen.
 *
 * **The mounting decision.** `Mentiora.configure(config); await
 * Mentiora.open();` must work with nothing else mounted (design.md:117-121),
 * so this module takes `AppRegistry.setWrapperComponentProvider`, composed
 * with whichever provider is already installed, at IMPORT TIME — never
 * overwritten outright, since it is a single global slot another library may
 * also want. `package.json`'s `sideEffects` field marks this file as having
 * one rather than dropping the flag package-wide.
 *
 * A real caveat, not fully solvable through `AppRegistry`'s public surface:
 * there is no getter for whichever provider is CURRENTLY installed, only the
 * setter. A provider installed before this module ever imports cannot be
 * read back — only ever a provider some OTHER call installs after this
 * module's own patched setter is in place. In practice this SDK is meant to
 * be imported early (like any wrapper-installing library), which is the
 * direction the patch actually protects.
 */
import type React from 'react';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { WrapperComponentProvider } from 'react-native';
import { AppRegistry, Modal } from 'react-native';
import { isBackHeld } from './back-hold.js';
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
};

let state: PresenterState = { visible: false, config: null, reloadKey: 0 };
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const fn of listeners) fn();
};

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    // The last (only, in practice — production mounts exactly one, forever,
    // via the wrapper installed below) host reading this state is gone: there
    // is nothing left to render a Modal into, so the next `configure()`/
    // `open()` starts fresh rather than resuming stale state from a host that
    // no longer exists. Harmless in production (the host never unmounts);
    // this is what keeps repeated test runs independent of each other.
    if (listeners.size === 0) state = { visible: false, config: null, reloadKey: 0 };
  };
};

const getSnapshot = (): PresenterState => state;

export const Mentiora = {
  configure(config: MentioraConfig): void {
    state = { ...state, config };
    notify();
  },
  async open(): Promise<void> {
    if (!state.config) {
      throw new Error(
        'Mentiora.open() was called before Mentiora.configure(config). Call Mentiora.configure() first.',
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

// -- AppRegistry.setWrapperComponentProvider, chained ------------------------
//
// Read the existing provider first and compose it — never overwrite. Since
// there's no getter, "the existing provider" means whichever one is installed
// through THIS patched setter from here on, in either direction: another
// library's later `setWrapperComponentProvider` call is captured and nested
// with ours rather than replacing it.
let externalProvider: WrapperComponentProvider | undefined;
const installSetter = AppRegistry.setWrapperComponentProvider;

const composedProvider: WrapperComponentProvider = (appParameters) => {
  const Outer = externalProvider?.(appParameters);
  const Inner = ({ children }: { children?: React.ReactNode }): React.JSX.Element => (
    <>
      {children}
      <MentioraPresenterHost />
    </>
  );
  if (!Outer) return Inner;
  return ({ initialProps, children }: { initialProps?: unknown; children?: React.ReactNode }) => (
    <Outer initialProps={initialProps}>
      <Inner>{children}</Inner>
    </Outer>
  );
};

// Patch the SETTER itself (not merely call it once): a later caller — the
// host app's own `index.js`, another library — must still have its provider
// composed in, not silently dropped by whichever of us happened to run last.
AppRegistry.setWrapperComponentProvider = (provider: WrapperComponentProvider): void => {
  externalProvider = provider;
  installSetter(composedProvider);
};
// And install ours right away too, so a host that never itself calls this at
// all still gets `<MentioraPresenterHost />` mounted (design.md: "no root
// provider" from the customer's own code).
installSetter(composedProvider);

/** Test-only (mirrors `runtime.ts`'s `__resetRuntimes`): the live composed
 *  provider, so a test can call it directly and observe whether it consults
 *  whatever provider was registered through the (patched) setter, without
 *  needing a real `AppRegistry.runApplication()` — which needs a native
 *  surface Jest doesn't have — to invoke it. */
export const __composedProviderForTest = (): WrapperComponentProvider => composedProvider;

/** Mounted once, globally, by the wrapper composed above — never something a
 *  host app renders itself. Exported anyway: it is also how tests mount it. */
export function MentioraPresenterHost(): React.JSX.Element | null {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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

  const onRequestClose = useCallback((): void => {
    if (!blocked.current && isBackHeld(config.embedKey)) return; // held: stay open
    Mentiora.close();
  }, [config]);

  return (
    <Modal visible onRequestClose={onRequestClose}>
      <MentioraWidget key={reloadKey} {...config} onEvent={onEvent} />
    </Modal>
  );
}
