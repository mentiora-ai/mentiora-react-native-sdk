/** Relays the widget's `onHardwareBack` to `<Modal onRequestClose>`: RN emits no
 *  hardware-back events while a Modal is open. Registered per widget instance
 *  via context, never keyed by `embedKey` — two widgets can share one. */
import { createContext } from 'react';

/** `true` == handled, keep the Modal open; `false` == `Mentiora.close()`. */
export type BackPress = () => boolean;

/** `null` outside a `<MentioraHost />`'s Modal — the inline case. */
export const BackChannelContext = createContext<((press: BackPress | null) => void) | null>(null);
