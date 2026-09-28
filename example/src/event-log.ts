import type { MentioraEvent } from '@mentiora-ai/react-native-sdk';
import { useSyncExternalStore } from 'react';

const LIMIT = 50;

export type Entry = { id: number; text: string };

// Replaced only on push, so the `useSyncExternalStore` snapshot stays referentially stable.
let entries: readonly Entry[] = [];
const listeners = new Set<() => void>();
let nextId = 0;
let previousAt: number | undefined;

// Prefixes ms since the previous entry; `open()` to `ready` is the widget's boot cost.
const push = (text: string): void => {
  const at = Date.now();
  const delta = previousAt === undefined ? '' : `+${String(at - previousAt)}ms `;
  previousAt = at;
  entries = [{ id: nextId++, text: `${delta}${text}` }, ...entries].slice(0, LIMIT);
  for (const listener of listeners) listener();
};

export const note = (text: string): void => push(`· ${text}`);

export const record = (event: MentioraEvent): void => push(JSON.stringify(event));

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useEventLog = (): readonly Entry[] => useSyncExternalStore(subscribe, () => entries);
