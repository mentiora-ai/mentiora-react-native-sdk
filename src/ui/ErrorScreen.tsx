import type React from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import type { MentioraErrorCode } from '../types.js';
import { DEFAULT_STRINGS, type MentioraStrings } from './strings.js';

export type ErrorScreenProps = {
  strings?: Partial<MentioraStrings>;
  code: MentioraErrorCode;
  onRetry: () => void;
  onDismiss: () => void;
};

/** Covers a dead WebView. Dismiss is the only way out, since the page draws its
 *  own chrome. `code` is not displayed. */
export function ErrorScreen(props: ErrorScreenProps): React.JSX.Element {
  const { strings, onRetry, onDismiss } = props;
  // Not a spread: an explicit `undefined` would blank a label.
  const s = { ...DEFAULT_STRINGS };
  for (const key of Object.keys(DEFAULT_STRINGS) as (keyof MentioraStrings)[]) {
    const value = strings?.[key];
    if (value !== undefined) s[key] = value;
  }

  // Follows the system scheme so a dark app is not flashed white; hosts wanting their own
  // design use `renderError`.
  const palette = useColorScheme() === 'dark' ? DARK : LIGHT;

  return (
    <View
      testID="mentiora-error"
      style={[styles.container, { backgroundColor: palette.background }]}
    >
      <Text style={[styles.title, { color: palette.text }]}>{s.errorTitle}</Text>
      <Text style={[styles.body, { color: palette.text }]}>{s.errorBody}</Text>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={s.retry}
          style={[styles.button, { backgroundColor: palette.button }]}
          onPress={onRetry}
        >
          <Text style={[styles.buttonText, { color: palette.text }]}>{s.retry}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={s.dismiss}
          style={[styles.button, { backgroundColor: palette.button }]}
          onPress={onDismiss}
        >
          <Text style={[styles.buttonText, { color: palette.text }]}>{s.dismiss}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const LIGHT = { background: '#ffffff', text: '#000000', button: '#f0f0f0' };
const DARK = { background: '#000000', text: '#ffffff', button: '#2c2c2e' };

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
  },
  body: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 24,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
  },
  button: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '500',
  },
});
