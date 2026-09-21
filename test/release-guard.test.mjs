// The release guard is the only non-trivial logic in the scaffold: it is what
// stops a mismatched tag from publishing. Node's own test runner, so the check
// needs no test framework installed.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const guard = new URL('../scripts/assert-version.mjs', import.meta.url).pathname;

const run = (tag) =>
  execFileSync(process.execPath, [guard, tag], { encoding: 'utf8', stdio: 'pipe' });

test('accepts the tag matching package.json', () => {
  assert.match(run(`v${pkg.version}`), /matches package.json/);
});

test('accepts the tag without a v prefix', () => {
  assert.match(run(pkg.version), /matches package.json/);
});

test('rejects a tag that does not match package.json', () => {
  assert.throws(() => run('v9.9.9'), /does not match package.json version/);
});

test('rejects no tag at all', () => {
  assert.throws(
    () => execFileSync(process.execPath, [guard], { encoding: 'utf8', stdio: 'pipe', env: {} }),
    /no tag given/,
  );
});

test('rejects a prerelease flag that disagrees with the version', () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, [guard, `v${pkg.version}`], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, RELEASE_PRERELEASE: 'true' },
      }),
    /is not a prerelease, but the GitHub Release is marked as one/,
  );
});

test('rejects a version with no CHANGELOG.md section', () => {
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.match(changelog, new RegExp(`^## ${pkg.version}$`, 'm'));
});

test('src/version.ts is in sync with package.json', () => {
  const version = readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8');
  assert.ok(version.includes(`'${pkg.version}'`), 'run bun run gen:version and commit it');
});
