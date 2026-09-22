import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// The guard resolves what it reads from its own location, so a throwaway tree with a copy of it is the real path.
const guardTree = (changelog) => {
  const root = mkdtempSync(join(tmpdir(), 'release-guard-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  copyFileSync(guard, join(root, 'scripts', 'assert-version.mjs'));
  copyFileSync(new URL('../package.json', import.meta.url).pathname, join(root, 'package.json'));
  copyFileSync(
    new URL('../src/version.ts', import.meta.url).pathname,
    join(root, 'src/version.ts'),
  );
  writeFileSync(join(root, 'CHANGELOG.md'), changelog);
  return join(root, 'scripts', 'assert-version.mjs');
};

const runIn = (tree, tag) =>
  execFileSync(process.execPath, [tree, tag], { encoding: 'utf8', stdio: 'pipe' });

test('rejects a version with no CHANGELOG.md section', () => {
  const tree = guardTree(`# Changelog\n\n## 0.0.1-other\n\n- something else\n`);
  assert.throws(() => runIn(tree, `v${pkg.version}`), new RegExp(`no "## ${pkg.version}" section`));
});

test('accepts the same tree once the section is there', () => {
  const tree = guardTree(`# Changelog\n\n## ${pkg.version}\n\n- initial release\n`);
  assert.match(runIn(tree, `v${pkg.version}`), /matches package.json/);
});

test("the real CHANGELOG.md has this version's section", () => {
  assert.match(
    readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
    new RegExp(`^## ${pkg.version}$`, 'm'),
  );
});

test('src/version.ts is in sync with package.json', () => {
  const version = readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8');
  assert.ok(version.includes(`'${pkg.version}'`), 'run bun run gen:version and commit it');
});
