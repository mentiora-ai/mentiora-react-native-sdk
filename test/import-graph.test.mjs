// `check-import-graph.mjs` proves a packed tarball works under npm: the resolve
// checks beside it never walk imports, so they pass a missing peer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const script = new URL('../scripts/check-import-graph.mjs', import.meta.url).pathname;

const tree = (source, installed = ['installed-peer']) => {
  const root = mkdtempSync(join(tmpdir(), 'import-graph-'));
  const lib = join(root, 'lib');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, 'index.js'), source);
  for (const name of installed) {
    const dir = join(root, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', main: 'index.js' }),
    );
    writeFileSync(join(dir, 'index.js'), 'module.exports = {};');
  }
  return { root, lib };
};

const run = (lib, root) =>
  execFileSync(process.execPath, [script, lib, root], { encoding: 'utf8', stdio: 'pipe' });

test('accepts a lib whose every external import resolves', () => {
  const { root, lib } = tree("import x from 'installed-peer';\nimport './rel.js';\n");
  assert.match(run(lib, root), /installed-peer/);
});

test('rejects an eager import of a package the consumer does not have', () => {
  const { root, lib } = tree("import y from 'phantom-dep';\n");
  assert.throws(() => run(lib, root), /phantom-dep/);
});

test('rejects an eager import of a deliberately absent OPTIONAL peer', () => {
  // The consumer job installs no safe-area-context; the absent path is the one that breaks.
  const { root, lib } = tree("export { a } from 'optional-peer';\n");
  assert.throws(() => run(lib, root), /optional-peer/);
});

test('ignores a lazily required optional peer, which is the supported shape', () => {
  const { root, lib } = tree(
    "export const load = () => { try { return require('optional-peer'); } catch { return null; } };\n",
  );
  assert.match(run(lib, root), /0 external import/);
});

test('ignores relative specifiers and node builtins', () => {
  const { root, lib } = tree("import { join } from 'node:path';\nimport './x.js';\n");
  assert.match(run(lib, root), /0 external import/);
});

test('fails when the lib directory holds no JavaScript at all', () => {
  const { root } = tree('');
  assert.throws(() => run(join(root, 'empty'), root), /nothing was checked/);
});
