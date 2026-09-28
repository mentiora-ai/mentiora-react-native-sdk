/**
 * The widget's recovery ladders: network failure, renderer crash, and a handshake or
 * `ready` that never arrives.
 * Every timer is tagged with the `generation` it was armed under and no-ops if that moved.
 */
import { backoff, delaysFor, type RetryPolicy } from './retry.js';
import type { MentioraErrorCode } from './types.js';

const LOAD_RETRY_POLICY: RetryPolicy = backoff(3);
// 3 automatic recoveries plus the incident that gives up.
const CRASH_RETRY_POLICY: RetryPolicy = backoff(4);

const HANDSHAKE_WATCHDOG_MS = 8000;
// The SDK draws no chrome, so a page that handshakes and never renders would strand the user.
const READY_WATCHDOG_MS = 10_000;
const HANDSHAKE_RECOVERY_CAP = 1;

export type LoadRecoveryDeps = {
  reload: () => void;
  /** Android cannot reuse a killed renderer, so a crash there remounts instead. */
  remount: () => void;
  /** A page load ended: drop everything the dead document held. */
  onLoadBoundary: () => void;
  /** The ladder gave up. */
  onGiveUp: (code: MentioraErrorCode) => void;
  hasSession: () => boolean;
};

export type LoadRecovery = {
  generation: () => number;
  /** Before any `await` in `initialize`: one at 7.9s must disarm the 8s watchdog. */
  handshakeStarted: () => void;
  /** Arms the `ready` watchdog. */
  handshakeSucceeded: (gen: number) => void;
  /** Success only, or a page that never renders becomes an unbounded reload loop. */
  ready: () => void;
  /** Re-arms: `onLoadEnd` will not fire again, so a rejected handshake would hang. */
  handshakeFailed: (gen: number) => void;
  /** A new top-frame document started loading. */
  navigated: () => void;
  loadEnded: () => void;
  loadFailed: () => void;
  /** iOS: the content process died and `reload()` revives it. */
  processTerminated: () => void;
  /** Android: the renderer is gone for good. */
  renderProcessGone: () => void;
  /** Host retry: a full remount with every counter reset. */
  restart: () => void;
  start: () => void;
  dispose: () => void;
};

type Counter = 'network' | 'crash' | 'handshake';

export const createLoadRecovery = (deps: LoadRecoveryDeps): LoadRecovery => {
  let generation = 0;
  // One incident can raise two callbacks; only the first advances a counter.
  let handled = false;
  // `crash` never resets on success: a react-native-webview#1767 crasher boots fine and dies later.
  const failures: Record<Counter, number> = { network: 0, crash: 0, handshake: 0 };
  // Not cleared in `onLoadStart`: Android raises it on in-page history changes too.
  let handshakeDone = false;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearWatchdog = (): void => {
    if (watchdogTimer !== null) clearTimeout(watchdogTimer);
    watchdogTimer = null;
  };
  const clearRecovery = (): void => {
    if (recoveryTimer !== null) clearTimeout(recoveryTimer);
    recoveryTimer = null;
  };

  const onTerminal = (fn: () => void): void => {
    if (handled) return;
    handled = true;
    fn();
  };

  const advanceGeneration = (): void => {
    deps.onLoadBoundary();
    handshakeDone = false;
    generation += 1;
    handled = false;
    clearRecovery();
    clearWatchdog();
  };

  const armWatchdog = (ms = HANDSHAKE_WATCHDOG_MS): void => {
    clearWatchdog();
    const gen = generation;
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      if (generation !== gen) return;
      onTerminal(() => {
        failures.handshake += 1;
        if (failures.handshake <= HANDSHAKE_RECOVERY_CAP) {
          beginFreshLoad();
          deps.reload();
        } else {
          deps.onGiveUp('handshake_timeout');
        }
      });
    }, ms);
  };

  const beginFreshLoad = (): void => {
    advanceGeneration();
    armWatchdog();
  };

  const scheduleRecovery = (delayMs: number, action: () => void): void => {
    clearRecovery();
    const gen = generation;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (generation !== gen) return;
      advanceGeneration();
      action();
    }, delayMs);
  };

  const climb = (
    counter: Counter,
    policy: RetryPolicy,
    code: MentioraErrorCode,
    recover: () => void,
  ): void => {
    onTerminal(() => {
      failures[counter] += 1;
      const attempt = failures[counter];
      if (attempt < policy.attempts) {
        scheduleRecovery(delaysFor(policy)[attempt - 1] ?? 0, recover);
      } else {
        deps.onGiveUp(code);
      }
    });
  };

  return {
    generation: () => generation,
    handshakeStarted: () => {
      clearWatchdog();
      handshakeDone = true;
    },
    handshakeSucceeded: (gen) => {
      if (gen !== generation) return;
      failures.network = 0;
      armWatchdog(READY_WATCHDOG_MS);
    },
    ready: () => {
      clearWatchdog();
      failures.handshake = 0;
    },
    handshakeFailed: (gen) => {
      if (gen === generation) armWatchdog();
    },
    navigated: beginFreshLoad,
    // `initialize` can land before load-end; arming then would silently reload a working
    // widget. Not keyed on the session key: it survives a ladder reload.
    loadEnded: () => {
      if (!handshakeDone) armWatchdog();
    },
    loadFailed: () => climb('network', LOAD_RETRY_POLICY, 'load_failed', deps.reload),
    processTerminated: () => climb('crash', CRASH_RETRY_POLICY, 'renderer_crashed', deps.reload),
    renderProcessGone: () => climb('crash', CRASH_RETRY_POLICY, 'renderer_crashed', deps.remount),
    restart: () => {
      failures.network = 0;
      failures.crash = 0;
      failures.handshake = 0;
      beginFreshLoad();
      deps.remount();
    },
    // The session-key guard stops an Offscreen re-show re-arming.
    start: () => {
      if (!deps.hasSession()) armWatchdog();
    },
    dispose: () => {
      clearWatchdog();
      clearRecovery();
      // An `initialize` rejecting after unmount must not re-arm the watchdog.
      generation += 1;
    },
  };
};
