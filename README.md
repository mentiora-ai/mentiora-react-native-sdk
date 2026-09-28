# Mentiora React Native SDK

Mentiora chat for React Native and Expo. It is pure JavaScript on top of `react-native-webview`, so it runs in Expo Go, dev builds and bare React Native.

## Install

Requires React 18+, React Native 0.76+ and `react-native-webview` 13.6–16.

```sh
npm install @mentiora-ai/react-native-sdk react-native-webview @react-native-async-storage/async-storage react-native-safe-area-context
```

The peers have native code, so they go in your app's own dependencies, where autolinking finds them; in an Expo app use `npx expo install` to get matching versions. Without AsyncStorage every launch is a new anonymous user. Without `react-native-safe-area-context`, which most apps already have, the SDK can't pass safe-area insets to the page.

## Overlay

`widgetUrl` comes from the install snippet in Mentiora admin. Mount `<MentioraHost />` once, as the last child of your app root, so it draws over your navigator.

```tsx
import { Mentiora, MentioraHost } from '@mentiora-ai/react-native-sdk';

Mentiora.configure({ widgetUrl: 'https://widget.<your-workspace>.mentiora.ai/h/rn/pk_wgt_…' });

export default function App() {
  return (
    <>
      <YourNavigator />
      <MentioraHost />
    </>
  );
}

Mentiora.open();
Mentiora.open({ threadId });
Mentiora.close();
```

`open()` called before `configure()` or before the host mounts is held until both exist. `close()` hides the overlay and keeps the page loaded for the next open.

## Inline

Place `<MentioraWidget />` in your own layout. To keep it loaded off-screen, pass `visible={false}` instead of unmounting it.

```tsx
import { MentioraWidget } from '@mentiora-ai/react-native-sdk';

<MentioraWidget widgetUrl={widgetUrl} identity={identity} visible={onSupportTab} />
```

## Identity

Omit `identity` for anonymous chat. It is compared by reference, and a new object reloads the page, so define it outside render. Pass either a callback:

```ts
const identity = { getToken: () => api.fetchIdentityToken() };
```

or a token endpoint for the SDK to call:

```ts
const identity = {
  endpoint: 'https://api.acme.com/mentiora/token',
  headers: () => ({ Authorization: `Bearer ${yourAuthToken()}` }),
  body: () => ({ locale }),
};
```

The SDK sends a JSON `POST` and accepts `{ "token": "…" }`, `{ "identityToken": "…" }` or a bare string. The token is a JWT whose `exp - iat` is at most 3600 seconds. The SDK caches it and refreshes it before `exp`.

Call `Mentiora.logout()` when the user signs out, and detach their device token in your backend. After a signed-in session, the install stays marked as signed in until `logout()`. Until then, each open without `identity` fails with an `identityError`.

## Events

```ts
Mentiora.configure({
  widgetUrl,
  onEvent: (event) => {
    if (event.type === 'unreadCountChanged') setBadge(event.count);
  },
});
```

| Event | Payload |
| --- | --- |
| `ready` | The page has rendered. |
| `close` | The user closed the widget. |
| `openUrl` | `url`, a link the page opened. By default the SDK opens `https:`, `mailto:` and `tel:` links; return `true` from `onOpenUrl` to handle a link yourself. |
| `error` | `code`: `load_failed`, `handshake_timeout` or `renderer_crashed`. |
| `identityError` | `reason`. |
| `storageUnavailable` | `reason`: `peer-absent` or `load-threw`. |
| `unreadCountChanged` | `count`, only while the page is loaded. |
| `installRefChanged` | `installRef`, or `null` after `logout()`. |

## Error screen

If the page cannot load, the SDK shows a screen with Retry and Dismiss. Change its copy with `strings`, or replace it with `renderError`, which must offer `dismiss`.

```tsx
Mentiora.configure({
  widgetUrl,
  renderError: ({ retry, dismiss }) => <BrandedError onRetry={retry} onClose={dismiss} />,
});
```

## Notifications

Enable the `message.missed` webhook in Mentiora admin under Integrations. The webhook names the user by `externalUserId` when signed in, or by `installRef` when anonymous. Store the device token under that key: read `installRef` with `Mentiora.getInstallRef()`, and follow `installRefChanged`, where `null` means detach it.

Send an alert push with this data block, using `threadId` as the collapse key:

```json
{ "mentiora": "1", "threadId": "<threadId from the webhook>" }
```

On tap, pass the push data to `Mentiora.handleNotificationOpen(data)`. It opens the thread and returns `false` for a push that is not Mentiora's. With `expo-notifications`, a push sent directly through APNs carries its data in `trigger.payload`, not `content.data`. [`example/src/push.ts`](example/src/push.ts) handles both.

## API

| | |
| --- | --- |
| `Mentiora.configure(config)` | Sets `widgetUrl`, `identity`, `onEvent`, `onOpenUrl`, `storage`, `strings` and `renderError`. Throws on a malformed `widgetUrl`. |
| `Mentiora.open({ threadId? })` | Shows the overlay. |
| `Mentiora.close()` | Hides it and keeps the page loaded. |
| `Mentiora.logout()` | Rotates the install id, clears the token and reloads. |
| `Mentiora.getInstallRef()` | The anonymous user's webhook key, or `null` before the first open. |
| `Mentiora.isMentioraPush(data)` | Whether a push data block is Mentiora's. |
| `Mentiora.handleNotificationOpen(data)` | Opens a Mentiora push's thread. |
| `<MentioraHost />` | The overlay. Mount it once. |
| `<MentioraWidget />` | Inline widget. Takes the config above plus `visible`. |

`storage` replaces AsyncStorage for the install id, with the same `getItem`, `setItem` and `removeItem`.

## Example

[`example/`](example/README.md) is an Expo app that drives both entry points against your widget.

## Development

Requires [Bun](https://bun.sh) 1.4.2 and Node 24.15.0. A published GitHub Release runs `.github/workflows/release.yml`, which publishes to npm.

```sh
bun install
bun run typecheck && bun run lint && bun run test && bun run build
```

## License

[Apache-2.0](LICENSE)
