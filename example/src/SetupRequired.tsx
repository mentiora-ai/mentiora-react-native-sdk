import type React from 'react';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export function SetupRequired({ malformed }: { malformed: boolean }): React.JSX.Element {
  return (
    <SafeAreaView testID="setup-required" style={styles.container}>
      <Text style={styles.title}>
        {malformed ? 'Widget URL not understood' : 'Configuration required'}
      </Text>
      {malformed ? (
        <Text style={styles.body}>
          <Text style={styles.code}>EXPO_PUBLIC_MENTIORA_WIDGET_URL</Text> is set but does not look
          like a hosted-page URL. It must be an origin followed by the embed key:
        </Text>
      ) : (
        <Text style={styles.body}>
          Copy <Text style={styles.code}>example/.env.example</Text> to{' '}
          <Text style={styles.code}>example/.env.local</Text> and set{' '}
          <Text style={styles.code}>EXPO_PUBLIC_MENTIORA_WIDGET_URL</Text> to the widget's hosted
          page:
        </Text>
      )}
      <Text style={styles.code}>https://widget.acme.mentiora.ai/h/rn/pk_wgt_…</Text>
      <Text style={styles.body}>
        Copy it from the install snippet in Mentiora admin. Expo inlines it at bundle time, so
        restart the bundler afterwards.
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 20, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 22 },
  code: { fontFamily: 'Courier', fontSize: 14 },
});
