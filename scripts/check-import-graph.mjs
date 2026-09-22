// Walks a built `lib/` for the external modules it EAGERLY imports, and
// asserts every one of them resolves from a consumer's own install.
//
// `require.resolve()` / `import.meta.resolve()` on the package entry prove only
// that the entry file exists: neither evaluates it, neither walks its imports.
// Evaluating it is not an option either — an RN entry pulls in Flow-typed
// `react-native` source that bare node cannot parse. Reading the import graph is
// what catches a runtime import missing from `peerDependencies`, or an eager
// import of an optional peer a consumer is allowed not to install.
//
// ESM build only: `import`/`export … from` are statements, so everything found
// here runs at load time. A lazily `require()`d optional peer (async-storage in
// storage.ts, safe-area-context in MentioraWidget.tsx) is try/catch-guarded by
// design and correctly not flagged; the same import written top-level would be.

import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { join, resolve } from 'node:path';

const [libDir, consumerDir] = process.argv.slice(2);
if (!libDir || !consumerDir) {
  console.error('usage: check-import-graph.mjs <lib-dir> <consumer-dir>');
  process.exit(2);
}

// `from '…'` on an import/export statement, plus the side-effect `import '…'`.
const FROM = /^\s*(?:import|export)\b[^'"]*\bfrom\s*['"]([^'"]+)['"]/;
const BARE = /^\s*import\s*['"]([^'"]+)['"]/;

const files = [];
for await (const file of glob('**/*.js', { cwd: resolve(libDir) })) files.push(file);
if (files.length === 0) {
  console.error(`check-import-graph: no .js under ${libDir} — nothing was checked`);
  process.exit(1);
}

const specifiers = new Map(); // specifier -> first file that imports it
for (const file of files) {
  const full = join(resolve(libDir), file);
  for (const line of readFileSync(full, 'utf8').split('\n')) {
    const m = FROM.exec(line) ?? BARE.exec(line);
    if (!m) continue;
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/') || isBuiltin(spec)) continue;
    if (!specifiers.has(spec)) specifiers.set(spec, file);
  }
}

const require = createRequire(join(resolve(consumerDir), 'noop.js'));
const missing = [];
for (const [spec, file] of specifiers) {
  try {
    require.resolve(spec);
  } catch (err) {
    missing.push(`${spec} (imported by lib/${file}): ${err.code ?? err.message}`);
  }
}

console.log(
  `check-import-graph: ${files.length} file(s), ${specifiers.size} external import(s): ` +
    `${[...specifiers.keys()].sort().join(', ') || 'none'}`,
);
if (missing.length > 0) {
  console.error(
    `check-import-graph: ${missing.length} import(s) do not resolve from ${consumerDir}:\n  ` +
      missing.join('\n  '),
  );
  process.exit(1);
}
