import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delaysFor, retry } from './retry.js';

const policy = {
  attempts: 3,
  baseMs: 1000,
  capMs: 8000,
  totalBudgetMs: 8000,
};

test('delays grow exponentially, are capped, and never exceed the budget', () => {
  const d = delaysFor(policy, () => 1); // full jitter, worst case
  assert.equal(d.length, 2); // 3 attempts = 2 waits
  assert.deepEqual(d, [1000, 2000]);
  assert.ok(d.reduce((a, b) => a + b, 0) <= policy.totalBudgetMs);
});

test('full jitter scales each delay by the random source', () => {
  assert.deepEqual(
    delaysFor(policy, () => 0.5),
    [500, 1000],
  );
});

test('retry returns the first success and stops', async () => {
  let calls = 0;
  const out = await retry(
    async (n) => {
      calls++;
      if (n < 2) throw new Error('no');
      return 'ok';
    },
    policy,
    async () => {},
    () => 1,
  );
  assert.equal(out, 'ok');
  assert.equal(calls, 2);
});

test('attempts are 1-based: first call is 1, last is policy.attempts', async () => {
  const received: number[] = [];
  await retry(
    async (n) => {
      received.push(n);
      if (n < policy.attempts) throw new Error('retry');
      return 'ok';
    },
    policy,
    async () => {},
    () => 1,
  );
  assert.equal(received[0], 1);
  assert.equal(received[received.length - 1], policy.attempts);
  assert.equal(received.length, policy.attempts);
});

test('retry rethrows the last error once attempts are spent', async () => {
  let calls = 0;
  await assert.rejects(
    retry(
      async () => {
        calls++;
        throw new Error('always');
      },
      policy,
      async () => {},
      () => 1,
    ),
    /always/,
  );
  assert.equal(calls, 3);
});

test('totalBudgetMs stops delays early, not truncated', () => {
  const budgetPolicy = {
    attempts: 4,
    baseMs: 3000,
    capMs: 8000,
    totalBudgetMs: 5000,
  };
  const d = delaysFor(budgetPolicy, () => 1);
  // 3000 fits the 5000 budget; the next 6000 does not, so the schedule stops.
  assert.deepEqual(d, [3000]);
});

test('sleep is called between attempts with exact delay values', async () => {
  const sleepCalls: number[] = [];
  const sleepFn = async (ms: number) => {
    sleepCalls.push(ms);
  };

  await assert.rejects(
    retry(
      async () => {
        throw new Error('fail');
      },
      policy,
      sleepFn,
      () => 1,
    ),
    /fail/,
  );

  // 3 attempts = 2 sleeps; baseMs=1000, capMs=8000, random=1 gives [1000, 2000].
  assert.equal(sleepCalls.length, 2);
  assert.deepEqual(sleepCalls, [1000, 2000]);
});
