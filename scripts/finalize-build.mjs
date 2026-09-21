// tsc cannot vary module system per output directory, so each build dir gets a
// package.json declaring its own type. This is what lets the root package.json
// stay type-less, which Jest and Metro's CJS-first resolution both prefer.
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const [dir, type] of [
  ['lib/commonjs', 'commonjs'],
  ['lib/module', 'module'],
]) {
  const target = join(root, dir);
  if (!existsSync(target)) {
    throw new Error(`${dir} missing — did the build run?`);
  }
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({ type }, null, 2)}\n`);
  console.log(`${dir}/package.json -> type: ${type}`);
}
