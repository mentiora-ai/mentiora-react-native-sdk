// The vendored bridge fixtures are immutable upstream: any sha256 drift from fixtures.lock.json is a bug here.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(root, 'src/bridge/v1/fixtures');
const lockPath = join(root, 'src/bridge/v1/fixtures.lock.json');

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const onDisk = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));

const problems = [];

for (const file of onDisk) {
  if (!(file in lock)) problems.push(`${file}: present on disk but not in fixtures.lock.json`);
}

for (const [file, expected] of Object.entries(lock)) {
  if (!onDisk.includes(file)) {
    problems.push(`${file}: locked but missing from disk`);
    continue;
  }
  const actual = createHash('sha256')
    .update(readFileSync(join(fixturesDir, file)))
    .digest('hex');
  if (actual !== expected) {
    problems.push(`${file}: sha256 mismatch (expected ${expected}, got ${actual})`);
  }
}

if (problems.length > 0) {
  console.error('check-fixtures: fixture drift detected');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`check-fixtures: ${onDisk.length} fixture(s) match the lock`);
