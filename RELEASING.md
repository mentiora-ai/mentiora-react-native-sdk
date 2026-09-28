# Releasing

1. Bump `version` in `package.json` and run `bun run gen:version` to regenerate `src/version.ts`.
2. Rename `## Unreleased` in `CHANGELOG.md` to `## <version>`.
3. Merge to `main`.
4. On GitHub, publish a Release with tag `v<version>` on `main`. Tick "pre-release" exactly when the version contains a `-`; it publishes under the `next` dist-tag instead of `latest`.

Publishing the Release runs `release.yml`. It refuses a tag that is not on `main`, and `scripts/assert-version.mjs` checks the tag against `package.json`, `src/version.ts`, the changelog heading and the pre-release flag. It then tests, builds and publishes with npm provenance.

## First publish

npm trusted publishing can only be configured on a package that already exists, so the first version goes out by hand:

```sh
git checkout main && git pull
bun install --frozen-lockfile && bun run build
npm publish --provenance=false --tag latest   # prompts for 2FA
```

Then on npmjs.com, open the package's Settings → Trusted publisher and add GitHub Actions with repository `mentiora-ai/mentiora-react-native-sdk` and workflow `release.yml`. Every later release uses the steps above. The repository must be public for npm to issue provenance.
