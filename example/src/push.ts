import { Mentiora } from '@mentiora/react-native-sdk';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { note } from './event-log';

// The SDK has no native code: permission, Android channel and token are the host's.
// Remote push needs a development build; Android Expo Go dropped it in SDK 53.

/** Must match the FCM `android.notification.channel_id` your backend sends. */
export const CHANNEL_ID = 'support-replies';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

// On iOS, expo-notifications fills `content.data` only from Expo's push service `body` key;
// a push sent straight through APNs has its keys only in `trigger.payload`.
const dataOf = (notification: Notifications.Notification): unknown => {
  const { content, trigger } = notification.request;
  if (Mentiora.isMentioraPush(content.data)) return content.data;
  return trigger && 'payload' in trigger ? trigger.payload : undefined;
};

const open = (response: Notifications.NotificationResponse, how: string): void => {
  // Otherwise every later launch from the app icon replays this tap.
  Notifications.clearLastNotificationResponse();
  const handled = Mentiora.handleNotificationOpen(dataOf(response.notification));
  note(`${how} tap: ${handled ? 'opened the widget on its thread' : 'not a Mentiora push'}`);
};

/** Register at the app root. `handleNotificationOpen` holds a cold-start tap until
 *  `Mentiora.configure()` and `<MentioraHost />` exist. */
export const listenForTaps = (): (() => void) => {
  const launch = Notifications.getLastNotificationResponse();
  if (launch) open(launch, 'cold');
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    open(response, 'warm');
  });
  return () => subscription.remove();
};

/** Your backend stores the device token keyed by `installRef` (anonymous) or
 *  `externalUserId` (signed in). */
export const enablePush = async (): Promise<void> => {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Support replies',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  const { granted } = await Notifications.requestPermissionsAsync();
  if (!granted) {
    note('push permission denied');
    return;
  }
  const token = await Notifications.getDevicePushTokenAsync();
  note(`device token (${token.type}): ${String(token.data)}`);
  note(`installRef: ${(await Mentiora.getInstallRef()) ?? 'null until the first open'}`);
};

/** The host owns the badge. When the page is not loaded, your push's `aps.badge`
 *  (from the webhook's `unreadCount.total`) sets it. */
export const showUnreadBadge = (count: number): void => {
  if (count === 0) void clearReadNotifications();
  Notifications.setBadgeCountAsync(count).then(
    (ok) => note(`badge ${String(count)}: ${ok ? 'set' : 'refused (badge permission?)'}`),
    (error: unknown) => note(`badge ${String(count)} failed: ${String(error)}`),
  );
};

const clearReadNotifications = async (): Promise<void> => {
  const presented = await Notifications.getPresentedNotificationsAsync();
  const ours = presented.filter((n) => Mentiora.isMentioraPush(dataOf(n)));
  await Promise.all(ours.map((n) => Notifications.dismissNotificationAsync(n.request.identifier)));
  if (ours.length > 0) note(`cleared ${String(ours.length)} read notification(s)`);
};
