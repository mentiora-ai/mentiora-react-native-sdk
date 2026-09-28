# Mentiora React Native SDK

Mentiora chat for React Native and Expo. It is pure JavaScript on top of `react-native-webview`, so it runs in Expo Go, dev builds and bare React Native.

## Install

AsyncStorage is optional, but without it every launch is a new anonymous user.

```sh
npm install @mentiora/react-native-sdk react-native-webview @react-native-async-storage/async-storage
```

## Configure

`widgetUrl` comes from the install snippet in Mentiora admin. Define `identity` once, outside render, because it is compared by reference; omit it for anonymous chat.

```ts
const widgetUrl = 'https://widget.<your-workspace>.mentiora.ai/h/rn/pk_wgt_…';

const identity = {
  endpoint: 'https://api.acme.com/mentiora/token',
  headers: () => ({ Authorization: `Bearer ${yourAuthToken()}` }),
};
```

## Overlay

Mount `<MentioraHost />` once, as the last child of your app root. `open()` waits for `configure()` and the host, and `close()` keeps the page warm for the next open.

```tsx
import { Mentiora, MentioraHost } from '@mentiora/react-native-sdk';

Mentiora.configure({ widgetUrl, identity });

export default function App() {
  return (
    <>
      <YourNavigator />
      <MentioraHost />
    </>
  );
}

await Mentiora.open();
await Mentiora.open({ threadId });
Mentiora.close();
```

## Inline

Place `<MentioraWidget />` in your own layout. To keep it warm off-screen, pass `visible={false}` instead of unmounting it.

```tsx
import { MentioraWidget } from '@mentiora/react-native-sdk';

<MentioraWidget widgetUrl={widgetUrl} identity={identity} visible={onSupportTab} />
```

## Events

`onEvent` receives `ready`, `close`, `openUrl`, `error`, `identityError`, `storageUnavailable`, `unreadCountChanged` and `installRefChanged`.

```ts
Mentiora.configure({
  widgetUrl,
  onEvent: (event) => {
    if (event.type === 'unreadCountChanged') setBadge(event.count);
  },
});
```

## Error screen

If the page cannot load, the SDK shows a screen with Retry and Dismiss. Change its copy with `strings`, or replace it with `renderError`, which must offer `dismiss`.

```tsx
Mentiora.configure({
  widgetUrl,
  renderError: ({ retry, dismiss }) => <BrandedError onRetry={retry} onClose={dismiss} />,
});
```

## Sign-out

Call `logout()` when the user signs out, and detach their device token in your backend so their replies stop reaching this device. A signed-in install later configured without `identity` gets an `identityError` instead of silently turning anonymous.

```ts
await Mentiora.logout();
```

## Notifications

Mentiora sends your backend a `message.missed` webhook, enabled in Mentiora admin under Integrations, and your backend sends the push. The webhook names the user by `externalUserId` when signed in, or by `installRef` when anonymous.

```ts
Mentiora.configure({
  widgetUrl,
  onEvent: (event) => {
    if (event.type === 'installRefChanged') void api.setPushOwner({ installRef: event.installRef });
  },
});
```

Send an alert push with this data block, using `threadId` as the collapse key.

```json
{ "mentiora": "1", "threadId": "<threadId from the webhook>" }
```

On tap, pass the push data to `handleNotificationOpen`, which needs `<MentioraHost />` and ignores pushes that are not Mentiora's.

```ts
import * as Notifications from 'expo-notifications';

const route = (response: Notifications.NotificationResponse): void => {
  Notifications.clearLastNotificationResponse();
  const { content, trigger } = response.notification.request;
  const data = Mentiora.isMentioraPush(content.data)
    ? content.data
    : trigger && 'payload' in trigger ? trigger.payload : undefined;
  Mentiora.handleNotificationOpen(data);
};

const launch = Notifications.getLastNotificationResponse();
if (launch) route(launch);
Notifications.addNotificationResponseReceivedListener(route);
```

## Development

Requires [Bun](https://bun.sh) 1.4.2 and Node 24.15.0. Releases follow [`RELEASING.md`](RELEASING.md).

```sh
bun install
bun run typecheck && bun run lint && bun run test && bun run build
```

## License

[Apache-2.0](LICENSE)
