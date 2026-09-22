// `run-core-tests.mjs` is all that stands between a tsconfig change that stops
// emitting core tests and a green CI running a silent subset. The marker each
// fixture leaves, not the exit code, proves it was executed rather than listed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const script = new URL('../scripts/run-core-tests.mjs', import.meta.url).pathname;

const PASSING = [
  "import { test } from 'node:test';",
  "import { writeFileSync } from 'node:fs';",
  "test('ok', () => { writeFileSync(new URL('./ran-' + import.meta.url.split('/').pop(), import.meta.url), 'x'); });",
  '',
].join('\n');

const tree = (sources, emitted) => {
  const root = mkdtempSync(join(tmpdir(), 'core-runner-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(script, join(root, 'scripts', 'run-core-tests.mjs'));
  for (const file of sources) {
    mkdirSync(join(root, 'src', ...file.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(root, 'src', file), '');
  }
  for (const file of emitted) {
    mkdirSync(join(root, 'lib-test', ...file.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(root, 'lib-test', file), PASSING);
  }
  return root;
};

const run = (root) => {
  // A nested `node --test` inheriting NODE_TEST_CONTEXT reports to a parent that
  // is not listening: it silently runs nothing. Dropping it makes the fixture run.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return execFileSync(process.execPath, [join(root, 'scripts', 'run-core-tests.mjs')], {
    encoding: 'utf8',
    stdio: 'pipe',
    env,
  });
};

test('passes when every core test source has an emitted counterpart', () => {
  const root = tree(
    ['a.test.ts', 'bridge/b.test.ts', 'c.test.tsx'],
    ['a.test.js', 'bridge/b.test.js', 'c.test.js'],
  );
  run(root);
  for (const marker of ['ran-a.test.js', 'bridge/ran-b.test.js', 'ran-c.test.js']) {
    assert.ok(existsSync(join(root, 'lib-test', marker)), `${marker} was never run`);
  }
});

test('fails when ONE source is dropped, not only when all of them are', () => {
  const root = tree(['a.test.ts', 'bridge/b.test.ts'], ['a.test.js']);
  assert.throws(() => run(root), /bridge\/b\.test\.ts/);
});

test('ignores the Jest-owned src/__tests__, which has no counterpart by design', () => {
  const root = tree(['a.test.ts', '__tests__/widget.test.tsx'], ['a.test.js']);
  run(root);
  assert.ok(existsSync(join(root, 'lib-test', 'ran-a.test.js')));
});

test('an empty project is still a legitimate state', () => {
  assert.doesNotThrow(() => run(tree([], [])));
});
