import { MentioraHost } from '@mentiora/react-native-sdk';
import { Stack } from 'expo-router';
import type React from 'react';
import { isConfigured, isMalformed } from '../src/config';
import { SetupRequired } from '../src/SetupRequired';

export default function RootLayout(): React.JSX.Element {
  // The home screen is the only `Mentiora.configure()` caller; sign-in/out reconfigures there.
  if (!isConfigured) return <SetupRequired malformed={isMalformed} />;

  // LAST child, not first: the host draws a sibling overlay now rather than presenting a
  // Modal, so it covers the navigator only by being later in the tree.
  return (
    <>
      <Stack>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        {/* No header: the SDK applies window safe-area insets, so a header would double-pad
            the top. The screen navigates back on the page's close event. */}
        <Stack.Screen name="inline" options={{ headerShown: false }} />
      </Stack>
      <MentioraHost />
    </>
  );
}
