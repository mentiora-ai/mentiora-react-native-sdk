// tsc cannot vary module system per output dir, so each gets its own package.json type.
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
