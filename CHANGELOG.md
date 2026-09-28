# Changelog

Each entry names the bridge protocol version that release speaks. Shipped SDK
versions live on inside host app binaries, so this file is a compatibility
document.

This file is the source of truth. GitHub Release notes are drafted from it, not
the other way round.

## Unreleased

Speaks mobile bridge protocol **v1**, with additive messages an older page ignores.

- Notifications for replies that arrive while the widget is closed. Your backend
  sends the push from Mentiora's `message.missed` webhook; see the README.
  - `Mentiora.getInstallRef()` and the `installRefChanged` event identify an anonymous user
    in that webhook.
  - `Mentiora.open({ threadId })`, `Mentiora.isMentioraPush(data)` and
    `Mentiora.handleNotificationOpen(data)` route a notification tap to its thread.
  - The `unreadCountChanged` event reports the unread total while the page is loaded.
  - Bridge: `mentiora/open` (host to page), `mentiora/unreadCountChanged` (page to host),
    and `InitializeResult.threadId`.
- **Behaviour change:** `Mentiora.open()` called before `configure()` or before
  `<MentioraHost />` mounts no longer throws. It waits for both, and warns in development
  after 5 seconds.
- `mentiora/initialize` from an install that was signed in, but has no identity now, answers
  `-32002` (identity unavailable) instead of `-32603`, so the page can ask the user to sign in
  again instead of showing "Update needed". `onEvent` also receives
  `{ type: 'identityError', reason: 'identity_required' }`, so the app can pass `identity` or
  call `Mentiora.logout()`.
- A backgrounded app now counts as hidden: the widget sends the page `mentiora/hide` when the
  app goes to the background and `mentiora/show` when it returns.

## 0.1.0

First working bridge. Speaks mobile bridge protocol **v1**.

- `<MentioraWidget />` embeds the widget inline; `Mentiora.open()` presents it over a Modal.
  `open()` requires `<MentioraHost />` to be mounted once at your app root, above your
  navigator, and throws an actionable error if it is not. Every open reloads the page: the
  thread is resumed from server state rather than kept warm.
- `Mentiora.logout()` rotates the install id and clears the cached token.
- `onEvent` reports `ready`, `close`, `identityError`, `openUrl`, `error` and
  `storageUnavailable` — the last when no persistent storage could be resolved, so every
  launch creates a new anonymous user.
- Identity as a `getToken` callback or a declarative fetcher, with retry on both the boot
  and refresh paths.
- Zero runtime dependencies. `@react-native-async-storage/async-storage` and
  `react-native-safe-area-context` are optional peers.

## 0.0.1

Scaffold release. Reserves the package name and proves the release path end to
end. The public API is present as types; every implementation throws.

Speaks no bridge protocol version yet.
