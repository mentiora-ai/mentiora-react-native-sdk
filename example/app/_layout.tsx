import { MentioraHost } from '@mentiora/react-native-sdk';
import { Stack } from 'expo-router';
import type React from 'react';
import { useEffect } from 'react';
import { isConfigured, isMalformed } from '../src/config';
import { enablePush, listenForTaps } from '../src/push';
import { SetupRequired } from '../src/SetupRequired';

export default function RootLayout(): React.JSX.Element {
  useEffect(() => listenForTaps(), []);
  // A real app asks for push permission in context, e.g. after the user's first message.
  useEffect(() => {
    if (isConfigured) void enablePush();
  }, []);

  if (!isConfigured) return <SetupRequired malformed={isMalformed} />;

  // Must be the last child: its overlay covers the navigator only by coming later in the tree.
  return (
    <>
      <Stack>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        {/* The SDK applies safe-area insets; a header would double-pad the top. */}
        <Stack.Screen name="inline" options={{ headerShown: false }} />
      </Stack>
      <MentioraHost />
    </>
  );
}
