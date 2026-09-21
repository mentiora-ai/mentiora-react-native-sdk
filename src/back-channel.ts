/**
 * Presenter-to-widget plumbing, not host API (plan Task 12, design.md §2.7;
 * fix round 3, replacing `back-hold.ts`).
 *
 * `<Modal onRequestClose>` lives in `presenter.tsx`, a different component
 * from the `<MentioraWidget />` it hosts, and RN's own docs say hardware-back
 * events "will not be emitted as long as the modal is open" — so the widget's
 * own `BackHandler` subscription (Task 11c) is dead while the Modal is up,
 * and `onRequestClose` needs some way to reach the SAME decision.
 *
 * That decision already exists: `onHardwareBack` (`MentioraWidget.tsx`) is
 * already `() => boolean` and already carries every guard the inline path
 * needs — `dismissed`, `errorCode !== null`, `backHeld`, and, critically,
 * `peer.sessionKey() !== null` checked fresh at press time (not trusted from
 * a stale flag), which is exactly what a transient reload's `resetLoad()`
 * invalidates. Re-deriving that decision from a raw "is back held" boolean
 * (fix round 1's `back-hold.ts`) reproduced only PART of it, which is how a
 * transient network blip left the Modal's back button permanently dead
 * (fix round 3, Critical 1): `sendBack()` silently no-ops once the session
 * key is cleared, and nothing told `onRequestClose` to stop trying.
 *
 * Keyed by WIDGET INSTANCE, never by `embedKey` (fix round 3, Critical 2):
 * design.md §3.1's own example app has an inline widget and the Modal on the
 * SAME embed key, so a map keyed by embedKey lets either one hijack or erase
 * the other's registration. A React context reaches exactly the widget
 * instance mounted under a given `<MentioraHost />`'s Modal, with no such
 * collision and no new public API: `ModalBody` provides it, `MentioraWidget`
 * registers into it only when a provider is actually present — an inline
 * widget with no Modal above it sees `null` and keeps using its own
 * `BackHandler` exactly as before.
 */
import { createContext } from 'react';

/** `true` == the press was handled, keep the Modal open (and the page was
 *  told); `false` == unhandled, `Mentiora.close()`. Exactly `onHardwareBack`'s
 *  own signature — this channel carries THAT function, not a re-derived one. */
export type BackPress = () => boolean;

/** `null` outside a `<MentioraHost />`'s Modal — the ordinary inline case,
 *  where `MentioraWidget` never calls this at all. */
export const BackChannelContext = createContext<((press: BackPress | null) => void) | null>(null);
