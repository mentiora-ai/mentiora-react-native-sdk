import { Mentiora } from '@mentiora-ai/react-native-sdk';
import { Link } from 'expo-router';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { canSignIn, identityFetcher, isConfigured, setCredentials, widgetUrl } from '../src/config';
import { EventLog } from '../src/EventLog';
import { note, record } from '../src/event-log';
import { showUnreadBadge } from '../src/push';
import {
  claimLaunch,
  forgetSignIn,
  recallSignIn,
  rememberSignIn,
  setPrincipal,
  usePrincipal,
} from '../src/session';

const configure = (identity: typeof identityFetcher | undefined): void => {
  Mentiora.configure({
    widgetUrl,
    identity,
    onEvent: (event) => {
      record(event);
      if (event.type === 'unreadCountChanged') showUnreadBadge(event.count);
      // A signed-in install got no identity: let the user sign in again or sign out.
      if (event.type === 'identityError') Mentiora.close();
    },
  });
};

const present = (): void => {
  note('open()');
  Mentiora.open();
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
    void (async () => {
      const user = canSignIn ? await recallSignIn() : null;
      if (user) {
        note(`restored sign-in as ${user.sub}`);
        setCredentials(user.sub, user.name);
        configure(identityFetcher);
        setPrincipal(user.sub);
      } else {
        configure(undefined);
      }
      present();
    })().catch((error: unknown) => {
      note(`open failed: ${String(error)}`);
    });
  }, []);

  const guard = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      note(`${label} failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  /** No `logout()`: it clears the signed-in marker, and a failed mint would then boot
   *  anonymous silently. */
  const signIn = useCallback(() => {
    void guard('signIn', async () => {
      note(`sign in as ${sub.trim()}`);
      setCredentials(sub.trim(), name.trim());
      configure(identityFetcher);
      setPrincipal(sub.trim());
      await rememberSignIn({ sub: sub.trim(), name: name.trim() });
    });
  }, [guard, sub, name]);

  const signOut = useCallback(() => {
    void guard('signOut', async () => {
      note('sign out');
      configure(undefined);
      await Mentiora.logout();
      await forgetSignIn();
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
          <Row label="widget" value={widgetUrl} />
          <Row label="principal" value={principal} testID="principal" />
        </View>

        <View style={styles.row}>
          <Button testID="open-button" title="Overlay" onPress={present} disabled={busy} primary />
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
