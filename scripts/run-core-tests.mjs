// Collects compiled core tests (lib-test/**/*.test.js) plus the standalone
// scripts under test/**/*.test.mjs and runs them all through node --test.
//
// The guard catches emit loss: a `src/**/*.test.ts(x)` source with no counterpart
// under lib-test. Without it, a glob that matches zero emitted files reports a
// pass. It pairs per file rather than counting, because a tsconfig change that
// drops all but one test file still satisfies a "more than zero" check and runs a
// silent subset. Zero core test sources is a legitimate state. `src/__tests__` is
// excluded: it belongs to Jest and tsconfig.test.json excludes it, so it has no
// counterpart by design. `bun run test:core` removes lib-test first, so a deleted
// source cannot leave a stale .js behind to be run or to satisfy the pairing.
import { spawnSync } from 'node:child_process';
import { glob } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const collect = async (pattern) => {
  const matches = [];
  for await (const file of glob(pattern, { cwd: root })) {
    matches.push(file);
  }
  return matches;
};

const JEST_OWNED = /^src[\\/]__tests__[\\/]/;

const sourceFiles = [
  ...(await collect('src/**/*.test.ts')),
  ...(await collect('src/**/*.test.tsx')),
].filter((file) => !JEST_OWNED.test(file));
const emittedFiles = await collect('lib-test/**/*.test.js');
const releaseFiles = await collect('test/**/*.test.mjs');

const emitted = new Set(emittedFiles);
const unemitted = sourceFiles.filter(
  (file) => !emitted.has(file.replace(/^src[\\/]/, 'lib-test/').replace(/\.tsx?$/, '.js')),
);

if (unemitted.length > 0) {
  console.error(
    `run-core-tests: ${unemitted.length} of ${sourceFiles.length} core test source(s) have no emitted counterpart under lib-test — tsconfig.test.json is dropping them, refusing to report a pass:\n  ${unemitted.join('\n  ')}`,
  );
  process.exit(1);
}

const files = [...emittedFiles, ...releaseFiles].sort();

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
