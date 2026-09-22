/**
 * Carries the widget's own `onHardwareBack` to the `<Modal onRequestClose>` in
 * `presenter.tsx`. Presenter-to-widget plumbing, not host API.
 *
 * RN's docs say hardware-back events "will not be emitted as long as the modal
 * is open", so the widget's own `BackHandler` subscription is dead while the
 * Modal is up and `onRequestClose` has to reach the same decision.
 * `onHardwareBack` already is `() => boolean` and already checks `dismissed`,
 * `errorCode !== null`, `backHeld` and `peer.sessionKey() !== null` fresh at
 * press time, so this channel carries that function rather than a re-derived
 * boolean — a reload's `resetLoad()` invalidates the session key, and anything
 * that does not re-check it keeps claiming presses `sendBack()` then silently
 * drops.
 *
 * Registration is per WIDGET INSTANCE, through React context, never keyed by
 * `embedKey`: an inline widget and a Modal-hosted one can share an embed key,
 * and a map keyed that way lets either erase the other's registration.
 * `ModalBody` provides the context and `MentioraWidget` registers only when a
 * provider is present, so an inline widget with no Modal above it sees `null`
 * and keeps using `BackHandler`.
 */
import { createContext } from 'react';

/** `true` == the press was handled, keep the Modal open (and the page was
 *  told); `false` == unhandled, `Mentiora.close()`. Exactly `onHardwareBack`'s
 *  signature — this channel carries that function itself. */
export type BackPress = () => boolean;

/** `null` outside a `<MentioraHost />`'s Modal — the inline case, where
 *  `MentioraWidget` never calls this. */
export const BackChannelContext = createContext<((press: BackPress | null) => void) | null>(null);
