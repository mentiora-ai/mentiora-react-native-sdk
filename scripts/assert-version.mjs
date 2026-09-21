// Release guard. The GitHub Releases UI lets a human tag any commit with any
// text, so nothing ties the published version to the tag, to the changelog, or
// to the prerelease flag by itself. Run before publish.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const ref = process.env.GITHUB_REF_NAME ?? process.argv[2];
if (!ref) {
  throw new Error('no tag given: set GITHUB_REF_NAME or pass the tag as an argument');
}

const tagged = ref.replace(/^v/, '');
if (tagged !== pkg.version) {
  throw new Error(`tag ${ref} does not match package.json version ${pkg.version}`);
}

const version = readFileSync(join(root, 'src', 'version.ts'), 'utf8');
if (!version.includes(`'${pkg.version}'`)) {
  throw new Error('src/version.ts is stale — run "bun run gen:version" and commit it');
}

// The changelog names the bridge protocol version each release speaks, so a
// release without its entry ships a package whose compatibility is unrecorded.
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const heading = new RegExp(`^## ${pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
if (!heading.test(changelog)) {
  throw new Error(`CHANGELOG.md has no "## ${pkg.version}" section`);
}

// A prerelease published under the default dist-tag reaches every consumer
// running a plain install, so the semver and the GitHub prerelease flag have to
// agree before release.yml picks the tag from that same flag.
const isPrerelease = pkg.version.includes('-');
const flagged = process.env.RELEASE_PRERELEASE === 'true';
if (isPrerelease !== flagged) {
  throw new Error(
    `version ${pkg.version} ${isPrerelease ? 'is' : 'is not'} a prerelease, but the GitHub Release ` +
      `${flagged ? 'is' : 'is not'} marked as one`,
  );
}

console.log(`tag ${ref} matches package.json, src/version.ts and CHANGELOG.md`);
