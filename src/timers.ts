// Defaults for the injectable timer deps, so tests can drive time by hand.
export const setTimer = (fn: () => void, ms: number): unknown => setTimeout(fn, ms);

export const clearTimer = (handle: unknown): void =>
  clearTimeout(handle as Parameters<typeof clearTimeout>[0]);

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
