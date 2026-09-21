// Collects compiled core tests (lib-test/**/*.test.js) plus the standalone
// scripts under test/**/*.test.mjs (today, test/release-guard.test.mjs) and
// runs them all through node --test. Zero core test sources is a legitimate
// state (nothing written yet). What the guard actually catches is emit loss:
// src/**/*.test.ts(x) sources exist but tsconfig.test.json produced none of
// them in lib-test — the bug that made the original plan's
// lib/commonjs/**/*.test.js glob silently match zero files and pass.
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

const sourceFiles = [
  ...(await collect('src/**/*.test.ts')),
  ...(await collect('src/**/*.test.tsx')),
];
const emittedFiles = await collect('lib-test/**/*.test.js');
const releaseFiles = await collect('test/**/*.test.mjs');

if (sourceFiles.length > 0 && emittedFiles.length === 0) {
  console.error(
    `run-core-tests: ${sourceFiles.length} core test source(s) under src/**/*.test.ts(x) but 0 emitted under lib-test/**/*.test.js — tsconfig.test.json is dropping them, refusing to report a pass`,
  );
  process.exit(1);
}

const files = [...emittedFiles, ...releaseFiles].sort();

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
