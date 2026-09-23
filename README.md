# Mentiora React Native SDK

`@mentiora/react-native-sdk` — Mentiora chat for React Native and Expo.

A thin JavaScript wrapper around [`react-native-webview`](https://github.com/react-native-webview/react-native-webview)
that hosts the Mentiora widget page and implements the host side of the mobile
bridge protocol v1. No native module, so it runs in Expo Go, Expo dev builds and
bare React Native.

## Install

```sh
npm install @mentiora/react-native-sdk react-native-webview @react-native-async-storage/async-storage
```

`react-native-webview` is required. `@react-native-async-storage/async-storage`
is optional but recommended: without it the install id is held in memory and
every launch creates a new anonymous end user.

## Use

Embed the widget inline:

```tsx
import { MentioraWidget } from '@mentiora/react-native-sdk';

// Hoisted on purpose: `identity` is compared by reference. A fresh object
// literal on every render rebuilds the identity provider and discards its
// cached token with it, so no refresh ever reuses anything. Define it once —
// at module scope, or behind a `useMemo`.
const identity = {
  endpoint: 'https://api.acme.com/mentiora/token',
  headers: () => ({ Authorization: `Bearer ${yourAuthToken()}` }),
};

<MentioraWidget
  widgetOrigin="https://widget.acme.mentiora.ai"
  embedKey="pk_wgt_a1b2c3d4e5f6"
  identity={identity}
/>
```

Inline, **you** own the container, so you own how often the page loads. A widget on
a screen your navigator unmounts is destroyed with it, and the next visit is a fresh
load. To keep it warm, mount it somewhere that outlives the screen and pass
`visible={false}` rather than unmounting it:

```tsx
<MentioraWidget {...config} visible={onSupportTab} />
```

Parked that way it keeps its page and JS context, stops claiming the Android back
button, and is hidden from screen readers. Hide it with that prop, not with
`display: 'none'` or a zero size: iOS destroys a `WKWebView` that leaves the view
hierarchy, which is the document you were trying to keep.

Or present it over your app. Mount `<MentioraHost />` once, at your app root and
as the **last** child, so its overlay draws over your navigator. It renders
nothing until the first `open()`:

```tsx
import { Mentiora, MentioraHost } from '@mentiora/react-native-sdk';

Mentiora.configure({ widgetOrigin, embedKey, identity });

export default function App() {
  return (
    <>
      <YourNavigator />
      <MentioraHost />
    </>
  );
}
```

Then, from anywhere else in the app:

```ts
await Mentiora.open();
Mentiora.close();
await Mentiora.logout(); // rotates the install id and drops the cached token
```

`Mentiora.open()` throws if `<MentioraHost />` isn't mounted yet.

**The first `open()` loads the page; later ones do not.** Closing parks the
widget off-screen instead of destroying it, so the page and its JS context
survive and reopening costs a transform. Measured against a real deployment,
`open()` to `ready` was 2,538 ms cold and 1,470 ms on a reopen even with the
bundle already cached — that second number is parse and execute, which only a
live page avoids.

Nothing is mounted until the first `open()`, so a user who never opens the
widget costs you no WebView. A parked widget does not claim the Android back
button. There is no signal while the panel is closed in v0: no badge, no push.

Omit `identity` for anonymous chat. `widgetOrigin` and `embedKey` come from the
install snippet in Mentiora admin.

In normal operation the SDK renders no chat chrome: the page draws its own
header and close control. The one surface it owns is the failure screen — if
the page never loads, never completes the handshake, or the renderer keeps
dying, the SDK overlays a message with Retry and Dismiss, because a page that
cannot draw cannot draw a way out either.

## Peer versions

| Peer | Range |
| --- | --- |
| `react-native-webview` | `>=13.6.0 <17` |
| `@react-native-async-storage/async-storage` | `>=1.23.1 <4`, optional |
| `react-native` | `>=0.76` |
| `react` | `>=18` |
| `react-native-safe-area-context` | optional, used when present |

## Development

Requires [Bun](https://bun.sh) 1.4.2 and Node 24.15.0 (see `.nvmrc`).

```sh
bun install
bun run hooks      # once, installs the lefthook pre-commit hook
bun run typecheck
bun run lint
bun test
bun run build
```

Releases are cut by drafting a GitHub Release; see `CHANGELOG.md`, which is the
source of truth for release notes.

## License

MIT
