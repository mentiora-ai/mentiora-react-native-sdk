import type React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { MentioraErrorCode } from '../types.js';
import { DEFAULT_STRINGS, type MentioraStrings } from './strings.js';

export type ErrorScreenProps = {
  strings?: Partial<MentioraStrings>;
  code: MentioraErrorCode;
  onRetry: () => void;
  onDismiss: () => void;
};

/**
 * Covers a dead WebView. The hosted page draws its own chrome, so when it
 * never loads there is no close control anywhere else — Dismiss is the only
 * way out of the customer's app, not an optional affordance.
 *
 * `code` is not shown: all three MentioraErrorCode values render the same
 * plain-English `errorBody`. The code is for the host app, via `onEvent`.
 */
export function ErrorScreen(props: ErrorScreenProps): React.JSX.Element {
  const { strings, onRetry, onDismiss } = props;
  // A `{ ...DEFAULT_STRINGS, ...strings }` spread would let an explicit
  // `undefined` (e.g. `strings={{ retry: cond ? 'x' : undefined }}`) blank a
  // control's label, on the one screen whose only exit must stay visible.
  // Keys the caller set to undefined are skipped rather than applied.
  const s = { ...DEFAULT_STRINGS };
  for (const key of Object.keys(DEFAULT_STRINGS) as (keyof MentioraStrings)[]) {
    const value = strings?.[key];
    if (value !== undefined) s[key] = value;
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{s.errorTitle}</Text>
      <Text style={styles.body}>{s.errorBody}</Text>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={s.retry}
          style={styles.button}
          onPress={onRetry}
        >
          <Text style={styles.buttonText}>{s.retry}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={s.dismiss}
          style={styles.button}
          onPress={onDismiss}
        >
          <Text style={styles.buttonText}>{s.dismiss}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
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
    backgroundColor: '#f0f0f0',
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '500',
  },
});
