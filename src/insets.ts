// Android only: iOS WKWebView's `env(safe-area-inset-*)` is already per-view; Android's is the whole window's.
import type React from 'react';
import { Platform, StatusBar } from 'react-native';

export type HostInsets = { top: number; right: number; bottom: number; left: number };

// A non-finite field becomes `"undefinedpx"`, which drops the page's whole padding rule.
export const hasValidInsets = (insets: HostInsets): boolean =>
  Number.isFinite(insets.top) &&
  Number.isFinite(insets.right) &&
  Number.isFinite(insets.bottom) &&
  Number.isFinite(insets.left);

// A bare `require` in the ESM build throws a `ReferenceError` the catch would misreport.
export const loadSafeAreaInsets = (
  hasRequire: () => boolean = () => typeof require === 'function',
  requireModule?: () => unknown,
): HostInsets | null => {
  if (!hasRequire()) return null;
  try {
    // Directly inside `try`, or Metro fails the bundle when the peer is missing.
    const mod = (requireModule ? requireModule() : require('react-native-safe-area-context')) as {
      initialWindowMetrics?: { insets: HostInsets } | null;
    };
    const insets = mod.initialWindowMetrics?.insets;
    return insets && hasValidInsets(insets) ? insets : null;
  } catch {
    return null;
  }
};

type SafeAreaChange = { insets: HostInsets };
export type SafeAreaListenerComponent = React.ComponentType<{
  onChange: (change: SafeAreaChange) => void;
  style?: unknown;
  children?: React.ReactNode;
}>;

// 5.5+: reports the insets overlapping its own frame.
export const loadSafeAreaListener = (
  hasRequire: () => boolean = () => typeof require === 'function',
  requireModule?: () => unknown,
): SafeAreaListenerComponent | null => {
  if (!hasRequire()) return null;
  try {
    const mod = requireModule ? requireModule() : require('react-native-safe-area-context');
    const listener = (mod as { SafeAreaListener?: unknown }).SafeAreaListener;
    return typeof listener === 'function' ? (listener as SafeAreaListenerComponent) : null;
  } catch {
    return null;
  }
};

export const resolveHostInsets = (
  load: () => HostInsets | null = loadSafeAreaInsets,
): HostInsets | null => {
  const measured = load();
  if (measured) return measured;
  if (Platform.OS === 'android')
    return { top: StatusBar.currentHeight ?? 0, right: 0, bottom: 0, left: 0 };
  return null;
};

// `perView` tells the page it may use these in place of `env()`; window insets only raise it.
export const hostInsetsScript = (insets: HostInsets, perView = false): string => {
  const set = (name: string, px: number): string =>
    `document.documentElement.style.setProperty(${JSON.stringify(name)}, ${JSON.stringify(`${px}px`)});`;
  return (
    `document.documentElement.setAttribute("data-host-insets", ${JSON.stringify(perView ? 'view' : 'window')});` +
    set('--mw-host-inset-top', insets.top) +
    set('--mw-host-inset-right', insets.right) +
    set('--mw-host-inset-bottom', insets.bottom) +
    set('--mw-host-inset-left', insets.left) +
    'true;'
  );
};
