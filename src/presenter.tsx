/**
 * Presents `<MentioraWidget />` in a full-screen overlay mounted at the app root.
 *
 * The overlay is mounted on the first `open()` and kept mounted afterwards, so the
 * page's document and JS context survive a close and the next open costs a transform
 * rather than a page load. Nothing is mounted before the first open, so an app whose
 * user never opens the widget pays nothing.
 *
 * NOT a `Modal`: `Modal.render()` returns `null` whenever it is not showing, so its
 * children unmount and the WebView is destroyed — `visible={false}` keeps nothing warm.
 * Hiding is a translate off-screen, never `display: 'none'`, zero size or an unmount:
 * iOS creates the `WKWebView` lazily in `didMoveToWindow` and tears it down when the
 * view leaves the hierarchy, so any of those loses the document we are keeping.
 *
 * `AppRegistry.setWrapperComponentProvider` cannot replace `<MentioraHost />`: it has
 * no getter to chain an existing wrapper, and `runApplication` reads it once at launch.
 */
import type React from 'react';
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { BackHandler, StyleSheet, useWindowDimensions, View } from 'react-native';
import type { BackPress } from './back-channel.js';
import { BackChannelContext } from './back-channel.js';
import { MentioraWidget } from './MentioraWidget.js';
import { getRuntime } from './runtime.js';
import type { MentioraConfig, MentioraEvent } from './types.js';

type PresenterState = {
  visible: boolean;
  /** Latched by the first `open()`. Never cleared: it is what keeps the page warm. */
  mounted: boolean;
  config: MentioraConfig | null;
  activeHostId: number | null;
};

let state: PresenterState = {
  visible: false,
  mounted: false,
  config: null,
  activeHostId: null,
};
const listeners = new Set<() => void>();
// Added from a layout effect so an `open()` in a sibling's passive mount effect
// of the same commit already sees the host.
const hostIds: number[] = [];
// Ownership is picked from here so the owner is one that gets notified.
const subscribedIds: number[] = [];
let nextHostId = 0;

const notify = (): void => {
  for (const fn of listeners) fn();
};

// Oldest host owns the overlay, so two hosts mounted across a screen transition
// never show two widgets.
const registerHost = (id: number, onChange: () => void): (() => void) => {
  listeners.add(onChange);
  // StrictMode, Offscreen and Fast Refresh re-run effects without re-rendering;
  // without the re-add, `open()` would throw with a host still mounted.
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
    if (state.activeHostId === id) state = { ...state, activeHostId: subscribedIds[0] ?? null };
    notify();
  };
};

const getSnapshot = (): PresenterState => state;

export const Mentiora = {
  configure(config: MentioraConfig): void {
    const previous = state.config;
    state = { ...state, config };
    notify();
    // A signed-in user reopening a warm widget used to stay anonymous: the page keeps
    // the credential it booted with, and only a new document runs `initialize` again.
    // Unchanged identity must NOT reload — `strings` and `onEvent` change freely.
    if (state.mounted && previous !== null && previous.identity !== config.identity) {
      getRuntime(config).reload();
    }
  },
  async open(): Promise<void> {
    if (!state.config) {
      throw new Error(
        'Mentiora.open() was called before Mentiora.configure(config). Call Mentiora.configure() first.',
      );
    }
    if (hostIds.length === 0) {
      throw new Error(
        'Mentiora.open() needs <MentioraHost /> mounted once at your app root, as the LAST child so it draws over your navigator.',
      );
    }
    state = { ...state, visible: true, mounted: true };
    notify();
  },
  /** No-op when not configured or already closed. Leaves the page mounted and warm. */
  close(): void {
    if (!state.config || !state.visible) return;
    state = { ...state, visible: false };
    notify();
  },
  /** Rotates the install id, clears the identity cache and reloads every mounted
   *  widget. Throws before `configure()`: resolving would leave the previous
   *  user's install id in place. */
  async logout(): Promise<void> {
    if (!state.config) {
      throw new Error(
        'Mentiora.logout() was called before Mentiora.configure(config). Call Mentiora.configure() first.',
      );
    }
    await getRuntime(state.config).logout();
  },
};

/** Test-only. Call before rendering: a mounted host is lost until it resubscribes. */
export const __resetPresenter = (): void => {
  state = { visible: false, mounted: false, config: null, activeHostId: null };
  listeners.clear();
  hostIds.length = 0;
  subscribedIds.length = 0;
  nextHostId = 0;
};

/**
 * The component a host app mounts once, at its app root and as the LAST child, so the
 * overlay draws over the navigator. A `Modal` used to make order irrelevant; an overlay
 * obeys sibling order.
 */
export function MentioraHost(): React.JSX.Element | null {
  const id = useRef<number | undefined>(undefined);
  if (id.current === undefined) id.current = nextHostId++;
  const hostId = id.current;

  // Layout phase: visible to a same-commit `open()`, and a render that never
  // commits never counts.
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
      // Before the host callback: if that throws on `close`, the overlay would be
      // stranded over a blank `<View />`.
      if (event.type === 'close') Mentiora.close();
      config.onEvent?.(event);
    },
    [config],
  );

  /**
   * What `Modal.onRequestClose` used to do. Registered from the overlay rather than
   * the widget so it runs FIRST: React flushes child effects before the parent's, and
   * `BackHandler` calls the newest subscriber first. The page's own claim is consulted
   * through the back channel, exactly as the Modal did.
   */
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

  // Translated off-screen rather than hidden. A non-zero frame inside the window is
  // what keeps the iOS web content process alive.
  const { height } = useWindowDimensions();

  return (
    <BackChannelContext.Provider value={registerBackPress}>
      <View
        testID="mentiora-overlay"
        style={[StyleSheet.absoluteFill, visible ? null : { transform: [{ translateY: height }] }]}
        pointerEvents={visible ? 'auto' : 'none'}
        // A parked widget is not on screen, so it must not be reachable by a screen reader.
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      >
        <MentioraWidget {...config} onEvent={onEvent} visible={visible} />
      </View>
    </BackChannelContext.Provider>
  );
}
