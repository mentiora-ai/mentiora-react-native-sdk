import type { MentioraEvent } from '@mentiora/react-native-sdk';
import { MentioraWidget } from '@mentiora/react-native-sdk';
import { router } from 'expo-router';
import type React from 'react';
import { StyleSheet, View } from 'react-native';
import { identityFetcher, widgetUrl } from '../src/config';
import { record } from '../src/event-log';
import { usePrincipal } from '../src/session';

/**
 * `<MentioraWidget />` mounted inline. Embedded, the SDK only reports `{ type: 'close' }`;
 * this screen handles it by navigating back.
 */
export default function InlineScreen(): React.JSX.Element {
  const principal = usePrincipal();

  const onEvent = (event: MentioraEvent): void => {
    record(event);
    if (event.type === 'close') router.back();
  };

  return (
    <View style={styles.container}>
      <MentioraWidget
        widgetUrl={widgetUrl}
        identity={principal === 'anonymous' ? undefined : identityFetcher}
        onEvent={onEvent}
      />
    </View>
  );
}

const styles = StyleSheet.create({ container: { flex: 1 } });
