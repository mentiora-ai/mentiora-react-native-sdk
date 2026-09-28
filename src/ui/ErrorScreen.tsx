import type React from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import type { MentioraErrorCode } from '../types.js';
import { type MentioraStrings, resolveStrings } from './strings.js';

export type ErrorScreenProps = {
  strings?: Partial<MentioraStrings>;
  code: MentioraErrorCode;
  onRetry: () => void;
  onDismiss: () => void;
};

/** Dismiss is the only way out: the page draws its own chrome, which is gone. */
export function ErrorScreen(props: ErrorScreenProps): React.JSX.Element {
  const { onRetry, onDismiss } = props;
  const s = resolveStrings(props.strings);
  const palette = useColorScheme() === 'dark' ? DARK : LIGHT;

  return (
    <View
      testID="mentiora-error"
      style={[styles.container, { backgroundColor: palette.background }]}
    >
      <Text style={[styles.title, { color: palette.text }]}>{s.errorTitle}</Text>
      <Text style={[styles.body, { color: palette.text }]}>{s.errorBody}</Text>
      <View style={styles.actions}>
        <Button label={s.retry} palette={palette} onPress={onRetry} />
        <Button label={s.dismiss} palette={palette} onPress={onDismiss} />
      </View>
    </View>
  );
}

type Palette = typeof LIGHT;

function Button(props: {
  label: string;
  palette: Palette;
  onPress: () => void;
}): React.JSX.Element {
  const { label, palette, onPress } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.button, { backgroundColor: palette.button }]}
      onPress={onPress}
    >
      <Text style={[styles.buttonText, { color: palette.text }]}>{label}</Text>
    </Pressable>
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
