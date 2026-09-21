# Changelog

Each entry names the bridge protocol version that release speaks. Shipped SDK
versions live on inside customer app binaries, so this file is a compatibility
document.

This file is the source of truth. GitHub Release notes are drafted from it, not
the other way round.

## 0.1.0

First working bridge. Speaks mobile bridge protocol **v1**.

- `<MentioraWidget />` embeds the widget inline; `Mentiora.open()` presents it over a Modal.
- `Mentiora.logout()` rotates the install id and clears the cached token.
- Identity as a `getToken` callback or a declarative fetcher, with retry on both the boot
  and refresh paths.
- Zero runtime dependencies. `@react-native-async-storage/async-storage` and
  `react-native-safe-area-context` are optional peers.

## 0.0.1

Scaffold release. Reserves the package name and proves the release path end to
end. The public API is present as types; every implementation throws.

Speaks no bridge protocol version yet.
