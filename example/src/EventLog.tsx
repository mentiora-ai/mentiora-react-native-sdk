import type React from 'react';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useEventLog } from './event-log';

/** Maestro asserts on `event-log-count`, not log text. The newest event is `event-log-row-0`. */
export function EventLog(): React.JSX.Element {
  const entries = useEventLog();
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={styles.container}>
      <Pressable
        testID="event-log-toggle"
        onPress={() => setExpanded((was) => !was)}
        style={styles.bar}
      >
        {/* Points where the panel will go on tap: up to raise it, down to drop it.
            The panel is anchored to the bottom and grows upward. */}
        <View style={styles.chevronBox}>
          <View style={[styles.chevron, expanded ? null : styles.chevronUp]} />
        </View>
        <Text style={styles.title}>Events</Text>
        <Text testID="event-log-count" style={styles.count}>
          {entries.length}
        </Text>
      </Pressable>
      {expanded ? (
        <ScrollView testID="event-log" style={styles.log}>
          {entries.length === 0 ? (
            <Text style={styles.empty}>No events yet.</Text>
          ) : (
            entries.map((entry, i) => (
              <Text key={entry.id} testID={`event-log-row-${i}`} style={styles.row}>
                {entry.text}
              </Text>
            ))
          )}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#ccc' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  chevronBox: { width: 12, height: 12, alignItems: 'center', justifyContent: 'center' },
  /** Two borders of a square, rotated: 45deg points down, -135deg points up. */
  chevron: {
    width: 7,
    height: 7,
    borderRightWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: '#000',
    opacity: 0.45,
    transform: [{ translateY: -2 }, { rotate: '45deg' }],
  },
  chevronUp: { transform: [{ translateY: 2 }, { rotate: '-135deg' }] },
  title: { flex: 1, fontSize: 13, fontWeight: '600', opacity: 0.7 },
  count: { fontVariant: ['tabular-nums'], fontSize: 12, opacity: 0.5 },
  log: { maxHeight: 220, paddingHorizontal: 14, paddingBottom: 8 },
  empty: { opacity: 0.5, paddingVertical: 8 },
  row: { fontFamily: 'Courier', fontSize: 11, paddingVertical: 3 },
});
