// Collects compiled core tests (lib-test/**/*.test.js) plus the standalone
// scripts under test/**/*.test.mjs (today, test/release-guard.test.mjs) and
// runs them all through node --test. Fails loudly on an empty glob instead of
// exiting 0 on nothing — a misconfigured tsc emit must not read as a pass.
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

const coreFiles = await collect('lib-test/**/*.test.js');
const releaseFiles = await collect('test/**/*.test.mjs');

if (coreFiles.length === 0) {
  console.error(
    'run-core-tests: no compiled core tests found under lib-test/**/*.test.js — refusing to report a pass on an empty glob',
  );
  process.exit(1);
}

const files = [...coreFiles, ...releaseFiles].sort();

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
