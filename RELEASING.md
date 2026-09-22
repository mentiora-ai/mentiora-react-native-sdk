# Releasing

`bun run build` regenerates `src/version.ts` from `package.json`, and
`scripts/assert-version.mjs` runs before the build in `release.yml`, so bump the
version and commit the regenerated `src/version.ts` together or the publish
aborts.

Tag `v<version>`. The workflow verifies the tag against `package.json`,
`src/version.ts` and the `## <version>` heading in `CHANGELOG.md`.

## Gates on the first publish

Both must be resolved before `0.1.0` goes to npm.

### Bridge README amendment

The hosted page's bridge contract (`apps/widget/src/app/host/bridge/v1/README.md`
in `mentiora-cx`) needs two corrections. Neither is a bug in this package; both
are places where the published contract and a correct host disagree.

1. **Rejections must not carry the session key.** The contract requires every
   outbound message to carry `params.sessionKey` once a session exists,
   responses included, and the host-role fixtures assert it on an error
   response. That hands the key to any caller a `-32001` rejects — including the
   custom-block sandbox iframe the key exists to keep out. Error responses sent
   before the key has been verified should be unstamped, and
   `unauthorized-missing-session-key.json` re-recorded.

2. **An id-less message cannot be answered.** The contract says `-32001`
   rejection applies to requests, notifications and responses alike. JSON-RPC
   has no envelope for replying to a message with no `id`, so this host answers
   when there is an `id` and drops otherwise with a development warning. An
   error carrying `id: null` was considered and rejected: the page has no
   pending request to match it against.

Until the amendment lands, this package ships the contract as published,
including the stamped rejection.

### Device checks

Two behaviours are inferred from React Native source and have not been observed
on hardware. Both need ten minutes on a real device.

1. **Android, changing `embedKey` or `widgetOrigin` on a mounted widget.**
   `onShouldStartLoadWithRequest` is dispatched from `shouldOverrideUrlLoading`
   and not for `setSource` -> `loadUrl`, so Android may not cross a load
   boundary where iOS does. The props are documented as fixed for the life of an
   instance; confirm, or add an effect that begins a fresh load.

2. **Android, the first fragment jump on the landing document.** The last
   committed top-frame URL starts empty. If Android does not raise the
   navigation callback for the initial `loadUrl`, the first same-document jump
   is treated as a load boundary there.
