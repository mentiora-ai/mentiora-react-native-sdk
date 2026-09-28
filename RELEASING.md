# Releasing

`bun run build` regenerates `src/version.ts` from `package.json`, and
`scripts/assert-version.mjs` runs before the build in `release.yml`, so bump the
version and commit the regenerated `src/version.ts` together or the publish
aborts.

Tag `v<version>`. The workflow verifies the tag against `package.json`,
`src/version.ts` and the `## <version>` heading in `CHANGELOG.md`.
