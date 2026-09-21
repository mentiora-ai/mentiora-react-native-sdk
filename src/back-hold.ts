/**
 * Presenter-to-widget plumbing, not host API (plan Task 12, design.md §2.7).
 *
 * `<Modal onRequestClose>` lives in `presenter.tsx`, a different component
 * from the `<MentioraWidget />` it hosts, and RN's own docs say hardware-back
 * events "will not be emitted as long as the modal is open" — so the widget's
 * own `BackHandler` subscription (Task 11c) is dead while the Modal is up,
 * and `onRequestClose` needs some way to ask "is the page currently holding
 * the button?" without a new public event or prop on `MentioraConfig`
 * (anything there is versioned forever). A tiny keyed map, written by the
 * widget's existing `onBackHandling` handler and read by the presenter, is
 * the whole channel.
 */
const held = new Map<string, boolean>();

export const setBackHeld = (embedKey: string, value: boolean): void => {
  held.set(embedKey, value);
};

export const isBackHeld = (embedKey: string): boolean => held.get(embedKey) ?? false;

/** Tests only (mirrors `runtime.ts`'s `__resetRuntimes`). */
export const __resetBackHold = (): void => {
  held.clear();
};
