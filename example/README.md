# example

The example app is specified separately and is not part of the scaffold.

It will be an Expo app exercising both entry points: a header button calling
`Mentiora.open()`, and a tab embedding `<MentioraWidget />` directly, with
`<MentioraHost />` mounted once above the navigator — `Mentiora.open()` throws
without it. An Expo example covers the bare React Native path too, because this
package ships no native module; the reverse is not true.

Two things land with it rather than before it:

- an `expo export` bundle check on every pull request,
- the `.maestro/` flows and the nightly iOS/Android device workflows.

Both need a real app to run against. The research behind their shape is in
`.specs/sdk-v0/scaffold.md`.

This directory is a workspace member and is excluded from the published tarball
by the `files` allowlist in the root `package.json`.

> The `workspaces` entry in the root `package.json` arrives with this app.
> Bun rejects a workspace whose directory has no `package.json`.
