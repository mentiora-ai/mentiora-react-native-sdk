import { Mentiora } from '@mentiora/react-native-sdk';
import { Link } from 'expo-router';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  canSignIn,
  embedKey,
  identityFetcher,
  isConfigured,
  setCredentials,
  widgetOrigin,
  widgetUrlDisplay,
} from '../src/config';
import { EventLog } from '../src/EventLog';
import { note, record } from '../src/event-log';
import {
  armBootDeadline,
  claimLaunch,
  disarmBootDeadline,
  setPrincipal,
  usePrincipal,
} from '../src/session';

/** Pass the module-scope `identityFetcher` or `undefined`, never a fresh literal: the SDK
 *  compares `identity` by reference and drops its cached token on change. */
const configure = (identity: typeof identityFetcher | undefined): void => {
  Mentiora.configure({
    widgetOrigin,
    embedKey,
    identity,
    onEvent: (event) => {
      record(event);
      if (event.type === 'ready' || event.type === 'close' || event.type === 'error') {
        // `ready` also retires the deadline for good: from here the page is warm, so a
        // later open has no `ready` to wait for.
        disarmBootDeadline(event.type === 'ready');
      }
    },
  });
};

const present = async (): Promise<void> => {
  // Logged here, not in the button handler: the launch auto-open goes through this path
  // too, and without it the cold boot has nothing to measure against.
  note('open()');
  armBootDeadline(() => {
    note('page did not report ready — closing so the app stays reachable');
    Mentiora.close();
  });
  await Mentiora.open();
};

export default function HomeScreen(): React.JSX.Element {
  const [sub, setSubInput] = useState('alice');
  const [name, setNameInput] = useState('Alice');
  const principal = usePrincipal();
  const [busy, setBusy] = useState(false);
  const signedIn = principal !== 'anonymous';

  // A passive effect runs after the layout effect that registers `<MentioraHost />`.
  useEffect(() => {
    if (!isConfigured || !claimLaunch()) return;
    configure(undefined);
    void present().catch((error: unknown) => {
      record({ type: 'identityError', reason: `open: ${String(error)}` });
    });
  }, []);

  const guard = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      record({ type: 'identityError', reason: `${label}: ${String(error)}` });
    } finally {
      setBusy(false);
    }
  }, []);

  const open = useCallback(
    () =>
      void guard('open', async () => {
        await present();
      }),
    [guard],
  );

  /** Does not call `logout()`: that clears the `wasSignedIn` marker, and without it a
   *  failed token mint boots anonymous silently. */
  const signIn = useCallback(() => {
    void guard('signIn', async () => {
      note(`sign in as ${sub.trim()}`);
      setCredentials(sub.trim(), name.trim());
      configure(identityFetcher);
      setPrincipal(sub.trim());
    });
  }, [guard, sub, name]);

  const signOut = useCallback(() => {
    void guard('signOut', async () => {
      note('sign out');
      configure(undefined);
      await Mentiora.logout();
      setCredentials('', '');
      setPrincipal('anonymous');
    });
  }, [guard]);

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text testID="mentiora-ready" style={styles.heading}>
          Mentiora Example
        </Text>

        <View style={styles.card}>
          <Row label="widget" value={widgetUrlDisplay} />
          <Row label="principal" value={principal} testID="principal" />
        </View>

        <View style={styles.row}>
          <Button testID="open-button" title="Modal" onPress={open} disabled={busy} primary />
          <LinkButton testID="inline-button" title="Inline" href="/inline" />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Identity</Text>
          <Field
            testID="sub-input"
            label="user id (sub)"
            value={sub}
            onChangeText={setSubInput}
            autoCapitalize="none"
          />
          <Field
            testID="name-input"
            label="name (claim)"
            value={name}
            onChangeText={setNameInput}
            autoCapitalize="words"
          />
          <View style={styles.row}>
            <Button
              testID="signin-button"
              title="Sign in"
              onPress={signIn}
              disabled={busy || !canSignIn || sub.trim() === ''}
              primary={!signedIn}
            />
            {/* Not gated on `principal`: the `wasSignedIn` marker persists in AsyncStorage
                and every boot fails until `logout()` clears it. */}
            <Button
              testID="signout-button"
              title="Sign out"
              onPress={signOut}
              disabled={busy}
              primary={signedIn}
            />
          </View>
        </View>
      </ScrollView>
      <EventLog />
    </SafeAreaView>
  );
}

function Row(props: { label: string; value: string; testID?: string }): React.JSX.Element {
  return (
    <View style={styles.kv}>
      <Text style={styles.k}>{props.label}</Text>
      <Text testID={props.testID} style={styles.v}>
        {props.value}
      </Text>
    </View>
  );
}

function Field(props: {
  testID: string;
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  autoCapitalize: 'none' | 'words';
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <TextInput
        testID={props.testID}
        value={props.value}
        onChangeText={props.onChangeText}
        autoCapitalize={props.autoCapitalize}
        autoCorrect={false}
        style={styles.input}
      />
    </View>
  );
}

function LinkButton(props: { testID: string; title: string; href: '/inline' }): React.JSX.Element {
  return (
    <Link href={props.href} asChild>
      <Pressable testID={props.testID} style={styles.button}>
        <Text style={styles.buttonText}>{props.title}</Text>
      </Pressable>
    </Link>
  );
}

function Button(props: {
  testID: string;
  title: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      testID={props.testID}
      onPress={props.onPress}
      disabled={props.disabled}
      style={[
        styles.button,
        props.primary ? styles.buttonPrimary : null,
        props.disabled ? styles.buttonDisabled : null,
      ]}
    >
      <Text style={[styles.buttonText, props.primary ? styles.buttonTextPrimary : null]}>
        {props.title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  body: { padding: 16, gap: 16 },
  heading: { fontSize: 22, fontWeight: '700' },
  card: { gap: 10, padding: 14, borderRadius: 12, backgroundColor: '#f2f2f5' },
  cardTitle: { fontSize: 15, fontWeight: '600' },
  kv: { flexDirection: 'row', gap: 10 },
  k: { width: 84, fontSize: 13, opacity: 0.55 },
  v: { flex: 1, fontFamily: 'Courier', fontSize: 13, lineHeight: 18 },
  field: { gap: 4 },
  fieldLabel: { fontSize: 12, opacity: 0.55 },
  row: { flexDirection: 'row', gap: 10 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#bbb',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: 'Courier',
    fontSize: 14,
    backgroundColor: '#fff',
  },
  button: {
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: '#e2e2e7',
  },
  buttonPrimary: { backgroundColor: '#0a84ff' },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { fontSize: 15, fontWeight: '600' },
  buttonTextPrimary: { color: '#fff' },
});
