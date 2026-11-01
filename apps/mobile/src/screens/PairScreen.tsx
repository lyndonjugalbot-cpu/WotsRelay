import * as Device from 'expo-device';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { nativeTransport } from '../native-transport.ts';
import { pairDevice, parsePairingLink, type Pairing } from '../relay/client.ts';
import { space, type, usePalette } from '../theme.ts';
import { Button, Card, textStyles } from '../ui.tsx';

export function PairScreen({ initialLink, notice, onPaired }: { initialLink: string | null; notice: string | null; onPaired(p: Pairing): Promise<void> }) {
  const p = usePalette();
  const t = textStyles(p);
  const [link, setLink] = useState(initialLink ?? '');
  const [name, setName] = useState(Device.deviceName ?? 'iPhone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoTried = useRef<string | null>(null);

  const pair = async (value: string) => {
    setError(null);
    setBusy(true);
    try {
      await onPaired(await pairDevice(nativeTransport, parsePairingLink(value), name.trim() || 'iPhone'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Opening a pairing link on this phone is the intent to pair; do it without another tap.
  useEffect(() => {
    if (!initialLink || autoTried.current === initialLink) return;
    autoTried.current = initialLink;
    setLink(initialLink);
    void pair(initialLink);
  }, [initialLink]);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={t.title} accessibilityRole="header">
          Pair with your Mac
        </Text>
        <Text style={t.body}>WotsRelay runs on your Mac. This phone follows its sessions, answers approvals and continues paused work.</Text>
        {notice ? <Text style={[t.body, { color: p.paused }]}>{notice}</Text> : null}
        <Card>
          <Step n={1} text="On your Mac, turn on phone access:" code="wots gateway enable" />
          <Step n={2} text="Create a pairing link (valid 2 minutes, single use):" code="wots gateway pair" />
          <Step n={3} text="Open that link on this iPhone (AirDrop, Messages or Notes), or paste it below." />
        </Card>
        <TextInput
          accessibilityLabel="Pairing link"
          value={link}
          onChangeText={setLink}
          placeholder="wotsrelay://pair?…"
          placeholderTextColor={p.graphite}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          style={[styles.input, { color: p.ink, borderColor: p.hairline, backgroundColor: p.surface }]}
        />
        <View style={{ gap: space[1] }}>
          <Text style={t.small}>This phone’s name on your Mac</Text>
          <TextInput accessibilityLabel="Device name" value={name} onChangeText={setName} style={[styles.input, styles.single, { color: p.ink, borderColor: p.hairline, backgroundColor: p.surface }]} />
        </View>
        {error ? (
          <Text accessibilityLiveRegion="polite" style={[t.body, { color: p.failed }]}>
            {error}
          </Text>
        ) : null}
        <Button label={busy ? 'Pairing…' : 'Pair'} busy={busy} disabled={!link.trim()} onPress={() => void pair(link)} />
        <Text style={t.small}>The link carries your Mac’s certificate fingerprint. This phone will talk only to that Mac, and you can revoke it any time on your Mac with: wots devices revoke</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Step({ n, text, code }: { n: number; text: string; code?: string }) {
  const p = usePalette();
  const t = textStyles(p);
  return (
    <View style={styles.step}>
      <Text style={[styles.stepNumber, { color: p.focus, borderColor: p.focus }]}>{n}</Text>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={t.body}>{text}</Text>
        {code ? <Text style={[t.mono, { color: p.ink }]}>{code}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space[4], gap: space[4] },
  input: { borderWidth: 1, borderRadius: 8, padding: space[3], minHeight: 72, fontSize: type.size.sm, textAlignVertical: 'top' },
  single: { minHeight: 44 },
  step: { flexDirection: 'row', gap: space[3] },
  stepNumber: { width: 24, height: 24, borderRadius: 12, borderWidth: 1, textAlign: 'center', lineHeight: 22, fontWeight: '700', overflow: 'hidden' },
});
