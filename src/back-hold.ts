/**
 * Presenter-to-widget plumbing, not host API (plan Task 12, design.md §2.7).
 *
 * `<Modal onRequestClose>` lives in `presenter.tsx`, a different component
 * from the `<MentioraWidget />` it hosts, and RN's own docs say hardware-back
 * events "will not be emitted as long as the modal is open" — so the widget's
 * own `BackHandler` subscription (Task 11c) is dead while the Modal is up,
 * and `onRequestClose` needs some way to actually forward a press to the
 * page (`mentiora/back`) without a new public event or prop on
 * `MentioraConfig` (anything there is versioned forever). A tiny keyed map,
 * written by the widget's existing `onBackHandling` handler and read by the
 * presenter, is the whole channel.
 *
 * Fix round 1: carries the widget's own `sendBack` function, not a boolean.
 * A boolean only ever told the presenter whether to stay open; it gave the
 * PAGE no way to learn a press ever happened, so it could never release the
 * hold — back was dead for the life of the Modal. Registered when the page
 * claims the button, cleared (the entry removed, never left `undefined`)
 * when it releases and on unmount.
 */
type SendBack = () => void;

const handlers = new Map<string, SendBack>();

export const setBackHandler = (embedKey: string, sendBack: SendBack | null): void => {
  if (sendBack) handlers.set(embedKey, sendBack);
  else handlers.delete(embedKey);
};

export const getBackHandler = (embedKey: string): SendBack | undefined => handlers.get(embedKey);

/** Tests only. */
export const __resetBackHold = (): void => {
  handlers.clear();
};
