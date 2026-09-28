# Changelog

Each release names the bridge protocol version it speaks. GitHub Release notes are copied from here.

## 0.1.0

First release. Speaks mobile bridge protocol **v1**.

- `Mentiora.open()` shows the widget in an overlay drawn by `<MentioraHost />`, mounted once at the app root. An `open()` before `configure()` or before the host mounts is held until both exist, with a development warning after 5 seconds. `close()` hides the overlay and keeps the page loaded for the next open.
- `<MentioraWidget />` embeds the widget inline. `visible={false}` keeps it loaded off-screen.
- `widgetUrl` is the URL from the install snippet in Mentiora admin.
- Identity is a `getToken` callback or a token endpoint that the SDK fetches, caches and refreshes before `exp`. A new `identity` reloads the page. `Mentiora.logout()` rotates the install id and clears the cached token.
- An install that was signed in but has no `identity` now answers `initialize` with `-32002` and emits `identityError` with reason `identity_required`, so the page can ask the user to sign in again.
- `onEvent` reports `ready`, `close`, `openUrl`, `error`, `identityError`, `storageUnavailable`, `unreadCountChanged` and `installRefChanged`.
- Load failures, renderer crashes, and a page that never handshakes or never reports `ready` are retried, then end on an error screen with Retry and Dismiss. `strings` changes its copy and `renderError` replaces it.
- Notifications: `Mentiora.getInstallRef()`, `Mentiora.isMentioraPush(data)`, `Mentiora.handleNotificationOpen(data)` and `Mentiora.open({ threadId })` route a push sent from the `message.missed` webhook to its thread.
- The page receives `mentiora/hide` and `mentiora/show` when the widget is hidden or shown, and when the app goes to the background and returns.
- Bridge methods: `initialize`, `refreshIdentity`, `openUrl`, `ready`, `identityError`, `close`, `backHandling` and `unreadCountChanged` (page to host); `back`, `show`, `hide` and `open` (host to page).
- No runtime dependencies. `@react-native-async-storage/async-storage` and `react-native-safe-area-context` are optional peers.
