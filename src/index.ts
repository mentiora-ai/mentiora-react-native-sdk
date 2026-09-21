/**
 * Public API for @mentiora/react-native-sdk.
 *
 * Scaffold stub: the shapes below are the approved v0 surface (design.md §1).
 * Every implementation throws until the bridge lands, so the packaging, the
 * emitted .d.ts and the consumer install check are all exercised before any
 * protocol code exists.
 */

import { SDK_VERSION } from './version.js';

export { SDK_NAME, SDK_VERSION } from './version.js';

import type { MentioraConfig, MentioraWidgetProps } from './types.js';

export type {
  MentioraConfig,
  MentioraEvent,
  MentioraIdentity,
  MentioraIdentityCallback,
  MentioraIdentityFetcher,
  MentioraStorage,
  MentioraWidgetProps,
} from './types.js';

const notImplemented = (what: string): never => {
  throw new Error(
    `@mentiora/react-native-sdk@${SDK_VERSION}: ${what} is not implemented yet. ` +
      'This is a scaffold release; the bridge lands in 0.1.0.',
  );
};

/** Embed the widget inline. Renders no chrome: the page draws its own header. */
export function MentioraWidget(_props: MentioraWidgetProps): never {
  return notImplemented('<MentioraWidget />');
}

/**
 * Presenter. Keeps one WebView mounted across open and close, so opening does
 * not reload the page.
 */
export const Mentiora = {
  configure(_config: MentioraConfig): void {
    notImplemented('Mentiora.configure()');
  },
  open(): Promise<void> {
    return notImplemented('Mentiora.open()');
  },
  close(): void {
    notImplemented('Mentiora.close()');
  },
  /** Rotates the install id, drops the cached token and reloads the page. */
  logout(): Promise<void> {
    return notImplemented('Mentiora.logout()');
  },
};
