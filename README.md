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

Or present it over your app. Mount `<MentioraHost />` once, at your app root
above the navigator — it renders nothing until `open()` is called, and is
what gives `open()` somewhere to present the widget's `Modal`:

```tsx
import { Mentiora, MentioraHost } from '@mentiora/react-native-sdk';

Mentiora.configure({ widgetOrigin, embedKey, identity });

export default function App() {
  return (
    <>
      <MentioraHost />
      <YourNavigator />
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

**Every `open()` reloads the page, and that is deliberate.** Nothing stays
mounted while the panel is closed, so each open resumes the thread from server
state — which is what makes messages that arrived in the meantime appear. The
cost is a page load on every open; the benefit is that you never see stale
state. There is no signal while the panel is closed in v0: no badge, no push.

Omit `identity` for anonymous chat. `widgetOrigin` and `embedKey` come from the
install snippet in Mentiora admin.

The SDK renders no chrome: the page draws its own header and close control.

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
