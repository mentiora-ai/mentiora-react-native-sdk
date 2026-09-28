import { sleep as defaultSleep } from './timers.js';

export type RetryPolicy = {
  attempts: number;
  baseMs: number;
  capMs: number;
  totalBudgetMs: number;
};

/** Exponential from 1s, capped at 8s per step and 8s in total. */
export const backoff = (attempts: number): RetryPolicy => ({
  attempts,
  baseMs: 1000,
  capMs: 8000,
  totalBudgetMs: 8000,
});

export const delaysFor = (policy: RetryPolicy, random: () => number = Math.random): number[] => {
  const out: number[] = [];
  let spent = 0;
  for (let i = 0; i < policy.attempts - 1; i++) {
    const uncapped = policy.baseMs * 2 ** i;
    const full = Math.min(uncapped, policy.capMs);
    const jittered = Math.round(full * random());
    if (spent + jittered > policy.totalBudgetMs) break;
    out.push(jittered);
    spent += jittered;
  }
  return out;
};

export const retry = async <T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  random: () => number = Math.random,
): Promise<T> => {
  const delays = delaysFor(policy, random);
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      const delay = delays[attempt - 1];
      if (delay !== undefined) {
        await sleep(delay);
      }
    }
  }

  throw lastError;
};
