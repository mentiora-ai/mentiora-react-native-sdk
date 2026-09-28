/**
 * Overlay mounted on the first `open()` and kept mounted so the page stays warm.
 * Not a `Modal`: it unmounts children when hidden. Hidden by translating off-screen:
 * iOS tears down the `WKWebView` on `display: 'none'`, zero size or leaving the window.
 */
import type React from 'react';
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { BackHandler, StyleSheet, useWindowDimensions, View } from 'react-native';
import {
  BackChannelContext,
  type BackPress,
  isMentioraPush,
  type ThreadChannel,
  ThreadChannelContext,
} from './channels.js';
import { MentioraWidget } from './MentioraWidget.js';
import { getRuntime, type MentioraRuntime } from './runtime.js';
import type { MentioraConfig, MentioraEvent } from './types.js';
import { parseWidgetUrl } from './widget-url.js';

type PresenterState = {
  visible: boolean;
  mounted: boolean;
  config: MentioraConfig | null;
  activeHostId: number | null;
};

const HELD_OPEN_WARN_MS = 5000;

// All module state, so a test reset is one assignment.
const createStore = () => ({
  state: { visible: false, mounted: false, config: null, activeHostId: null } as PresenterState,
  listeners: new Set<() => void>(),
  /** Committed hosts; `open()` is held while there are none. */
  hostIds: new Set<number>(),
  /** Hosts subscribed to the store, oldest first. The owner is picked from here so it is
   *  always a host that gets notified. */
  subscribedIds: new Set<number>(),
  nextHostId: 0,
  // One slot: a later notification tap replaces an untaken one.
  pendingThreadId: null as string | null,
  threadListeners: new Set<() => void>(),
  // A notification tap that cold-starts the app calls `open()` before React renders.
  heldOpen: false,
  heldWarning: null as ReturnType<typeof setTimeout> | null,
  // Subscribed here, not in the overlay: a logout before the first open still rotates the id.
  refRuntime: null as MentioraRuntime | null,
  refUnsubscribe: null as (() => void) | null,
});

let store = createStore();

const notify = (): void => {
  for (const fn of store.listeners) fn();
};

const setState = (patch: Partial<PresenterState>): void => {
  store.state = { ...store.state, ...patch };
  notify();
};

const threadChannel: ThreadChannel = {
  take: () => {
    const id = store.pendingThreadId;
    store.pendingThreadId = null;
    return id;
  },
  subscribe: (fn) => {
    const { threadListeners } = store;
    threadListeners.add(fn);
    return () => threadListeners.delete(fn);
  },
};

const clearHeldWarning = (): void => {
  if (store.heldWarning !== null) clearTimeout(store.heldWarning);
  store.heldWarning = null;
};

const warnHeldOpen = (): void => {
  if (!__DEV__ || store.heldWarning !== null) return;
  store.heldWarning = setTimeout(() => {
    store.heldWarning = null;
    console.warn(
      store.state.config
        ? 'Mentiora.open() is waiting for <MentioraHost />. Mount it once at your app root, as the LAST child so it draws over your navigator.'
        : 'Mentiora.open() is waiting for Mentiora.configure(config) and <MentioraHost />.',
    );
  }, HELD_OPEN_WARN_MS);
};

const canShow = (): boolean => store.state.config !== null && store.hostIds.size > 0;

const show = (): void => {
  // Before `visible` flips, so a ready page gets `open` ahead of `show`.
  for (const fn of store.threadListeners) fn();
  setState({ visible: true, mounted: true });
};

const runHeldOpen = (): void => {
  if (!store.heldOpen || !canShow()) return;
  store.heldOpen = false;
  clearHeldWarning();
  show();
};

const followInstallRef = (config: MentioraConfig): void => {
  const runtime = getRuntime(config);
  if (runtime === store.refRuntime) return;
  store.refUnsubscribe?.();
  store.refRuntime = runtime;
  store.refUnsubscribe = runtime.onInstallRefChange((installRef) => {
    store.state.config?.onEvent?.({ type: 'installRefChanged', installRef });
  });
};

const oldest = (ids: Set<number>): number | null => ids.values().next().value ?? null;

// Oldest host owns the overlay, so two hosts across a screen transition show one widget.
// A `Set` ignores a re-add: StrictMode, Offscreen and Fast Refresh re-run effects.
const registerHost = (id: number, onChange: () => void): (() => void) => {
  const { listeners, hostIds, subscribedIds } = store;
  listeners.add(onChange);
  hostIds.add(id);
  subscribedIds.add(id);
  if (store.state.activeHostId === null) setState({ activeHostId: id });
  else notify();
  return () => {
    listeners.delete(onChange);
    hostIds.delete(id);
    subscribedIds.delete(id);
    if (store.state.activeHostId === id) setState({ activeHostId: oldest(subscribedIds) });
    else notify();
  };
};

const getSnapshot = (): PresenterState => store.state;

const requireConfig = (method: string): MentioraConfig => {
  const { config } = store.state;
  if (!config) {
    throw new Error(
      `Mentiora.${method}() was called before Mentiora.configure(config). Call Mentiora.configure() first.`,
    );
  }
  return config;
};

export const Mentiora = {
  configure(config: MentioraConfig): void {
    // Validated here so a bad URL fails at startup, not on the user's tap.
    parseWidgetUrl(config.widgetUrl);
    const previous = store.state.config;
    followInstallRef(config);
    setState({ config });
    // The page keeps the credential it booted with; only a new document re-runs `initialize`.
    // Reload on identity change only: `strings` and `onEvent` change freely.
    if (store.state.mounted && previous !== null && previous.identity !== config.identity) {
      getRuntime(config).reload();
    }
    runHeldOpen();
  },
  /** Held until both `configure()` has run and `<MentioraHost />` has mounted. */
  async open(options?: { threadId?: string }): Promise<void> {
    if (options?.threadId) store.pendingThreadId = options.threadId;
    if (!canShow()) {
      store.heldOpen = true;
      warnHeldOpen();
      return;
    }
    show();
  },
  /** Leaves the page mounted and warm. */
  close(): void {
    if (!store.state.config || !store.state.visible) return;
    setState({ visible: false });
  },
  /** Rotates the install id and reloads mounted widgets. Throws before `configure()`
   *  so the previous user's install id is never silently kept. */
  async logout(): Promise<void> {
    const config = requireConfig('logout');
    // A previous user's tap must not open the next user's page on that thread.
    store.pendingThreadId = null;
    await getRuntime(config).logout();
  },
  /** The key `message.missed` webhooks carry when there is no `externalUserId`.
   *  `null` until the widget has been opened once. */
  async getInstallRef(): Promise<string | null> {
    return getRuntime(requireConfig('getInstallRef')).installRef();
  },
  /** Whether a push's data block is Mentiora's: `{ mentiora: '1', threadId }`. */
  isMentioraPush(data: unknown): boolean {
    return isMentioraPush(data);
  },
  /** Returns `false` and does nothing for a push that is not Mentiora's. */
  handleNotificationOpen(data: unknown): boolean {
    if (!isMentioraPush(data)) return false;
    void Mentiora.open({ threadId: data.threadId });
    return true;
  },
};

/** Test-only. Call before rendering: a mounted host is lost until it resubscribes. */
export const __resetPresenter = (): void => {
  clearHeldWarning();
  store.refUnsubscribe?.();
  store = createStore();
};

/** Mount once at the app root as the LAST child, so the overlay draws over the navigator. */
export function MentioraHost(): React.JSX.Element | null {
  const id = useRef<number | undefined>(undefined);
  if (id.current === undefined) id.current = store.nextHostId++;
  const hostId = id.current;

  // Layout phase: visible to a same-commit `open()`; an uncommitted render never counts.
  useLayoutEffect(() => {
    const { hostIds } = store;
    hostIds.add(hostId);
    runHeldOpen();
    return () => {
      hostIds.delete(hostId);
    };
  }, [hostId]);

  const subscribeThis = useCallback(
    (onChange: () => void): (() => void) => registerHost(hostId, onChange),
    [hostId],
  );
  const snapshot = useSyncExternalStore(subscribeThis, getSnapshot, getSnapshot);

  if (snapshot.activeHostId !== hostId) return null;
  if (!snapshot.mounted || !snapshot.config) return null;
  return <Overlay config={snapshot.config} visible={snapshot.visible} />;
}

function Overlay({
  config,
  visible,
}: {
  config: MentioraConfig;
  visible: boolean;
}): React.JSX.Element {
  const backPress = useRef<BackPress | null>(null);
  const registerBackPress = useCallback((press: BackPress | null): void => {
    backPress.current = press;
  }, []);

  const onEvent = useCallback(
    (event: MentioraEvent) => {
      // Before the host callback, so a throwing callback cannot strand the overlay.
      if (event.type === 'close') Mentiora.close();
      // Already forwarded by `followInstallRef`.
      if (event.type === 'installRefChanged') return;
      config.onEvent?.(event);
    },
    [config],
  );

  // Registered in the overlay so it runs first: child effects flush before the parent's,
  // and `BackHandler` calls the newest subscriber first.
  const onHardwareBack = useCallback((): boolean => {
    if (!visible) return false;
    if (backPress.current?.()) return true;
    Mentiora.close();
    return true;
  }, [visible]);

  useLayoutEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', onHardwareBack);
    return () => {
      subscription.remove();
    };
  }, [onHardwareBack]);

  const { height } = useWindowDimensions();

  return (
    <BackChannelContext.Provider value={registerBackPress}>
      <ThreadChannelContext.Provider value={threadChannel}>
        <View
          testID="mentiora-overlay"
          style={[
            StyleSheet.absoluteFill,
            visible ? null : { transform: [{ translateY: height }] },
          ]}
          pointerEvents={visible ? 'auto' : 'none'}
          accessibilityElementsHidden={!visible}
          importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
        >
          <MentioraWidget {...config} onEvent={onEvent} visible={visible} />
        </View>
      </ThreadChannelContext.Provider>
    </BackChannelContext.Provider>
  );
}
