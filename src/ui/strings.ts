export type MentioraStrings = {
  errorTitle: string;
  errorBody: string;
  retry: string;
  dismiss: string;
};

export const DEFAULT_STRINGS: MentioraStrings = {
  errorTitle: 'Something went wrong',
  errorBody: 'Chat is unavailable. Check your connection and try again.',
  retry: 'Retry',
  dismiss: 'Dismiss',
};

/** Not a spread: an explicit `undefined` would blank a label. */
export const resolveStrings = (overrides?: Partial<MentioraStrings>): MentioraStrings => {
  const s = { ...DEFAULT_STRINGS };
  for (const key of Object.keys(DEFAULT_STRINGS) as (keyof MentioraStrings)[]) {
    const value = overrides?.[key];
    if (value !== undefined) s[key] = value;
  }
  return s;
};
