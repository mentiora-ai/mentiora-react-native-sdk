/** Contexts the `<MentioraHost />` overlay provides to its widget. An inline widget
 *  gets neither and reads `null`. */
import { createContext } from 'react';

/** `true` == handled; `false` lets the overlay call `Mentiora.close()`. */
export type BackPress = () => boolean;

/** Relays the widget's back handler to the overlay's, which runs first. Per widget
 *  instance, not per `embedKey` (two can share one). */
export const BackChannelContext = createContext<((press: BackPress | null) => void) | null>(null);

/** Hands a notification tap's thread from `Mentiora.open({ threadId })` to the
 *  overlay's widget, which delivers it in the handshake or as `mentiora/open`. */
export type ThreadChannel = {
  /** The pending thread, cleared by the read: each request reaches one document. */
  take: () => string | null;
  subscribe: (fn: () => void) => () => void;
};

export const ThreadChannelContext = createContext<ThreadChannel | null>(null);

/** A Mentiora push: the data block your server copies from the `message.missed` webhook. */
export const isMentioraPush = (data: unknown): data is { mentiora: '1'; threadId: string } => {
  if (typeof data !== 'object' || data === null) return false;
  const { mentiora, threadId } = data as Record<string, unknown>;
  return mentiora === '1' && typeof threadId === 'string' && threadId.length > 0;
};
