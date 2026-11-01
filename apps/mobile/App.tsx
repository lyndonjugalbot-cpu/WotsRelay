import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { Session } from '../../packages/protocol/src/index.ts';
import { nativeTransport } from './src/native-transport.ts';
import { forgetPairing, loadPairing, savePairing } from './src/pairing-store.ts';
import { RelayClient, type ConnectionState, type Pairing } from './src/relay/client.ts';
import { PairScreen } from './src/screens/PairScreen.tsx';
import { SessionScreen } from './src/screens/SessionScreen.tsx';
import { SessionsScreen } from './src/screens/SessionsScreen.tsx';
import { usePalette } from './src/theme.ts';

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const p = usePalette();
  const url = Linking.useLinkingURL();
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('offline');
  const [open, setOpen] = useState<Session | null>(null);

  useEffect(() => {
    // A Keychain failure must not leave the app spinning: fall back to pairing, and say why.
    loadPairing()
      .then(setPairing)
      .catch((e: unknown) => {
        setNotice(`Could not read this iPhone’s saved pairing (${e instanceof Error ? e.message : String(e)}). Pair again to continue.`);
        setPairing(null);
      });
  }, []);

  const client = useMemo(() => (pairing ? new RelayClient(pairing, nativeTransport) : null), [pairing]);

  useEffect(() => {
    if (!client) return;
    const off = client.onState(async (s) => {
      setConnection(s);
      if (s === 'revoked') {
        await forgetPairing();
        setOpen(null);
        setNotice('This iPhone was unpaired on your Mac. Create a new link on your Mac with: wots gateway pair');
        setPairing(null);
      }
    });
    client.start();
    // iOS drops sockets in the background; reconnect as soon as the app is visible again.
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active' && client.state !== 'online' && client.state !== 'revoked') {
        client.stop();
        client.start();
      }
    });
    return () => {
      off();
      sub.remove();
      client.stop();
    };
  }, [client]);

  const pairingLink = url?.startsWith('wotsrelay://pair') ? url : null;

  // wotsrelay://session/<id> opens that conversation (used by links and, later, notifications).
  useEffect(() => {
    const id = url?.match(/^wotsrelay:\/\/session\/([\w-]+)/)?.[1];
    if (!id || !client) return;
    void client
      .call<{ session: Session }>('sessions.get', { sessionId: id })
      .then((v) => setOpen(v.session))
      .catch(() => {});
  }, [url, client]);

  let screen;
  if (pairing === undefined) screen = <ActivityIndicator style={{ flex: 1 }} />;
  else if (!pairing || !client || (pairingLink && pairing === null))
    screen = (
      <PairScreen
        initialLink={pairingLink}
        notice={notice}
        onPaired={async (pr) => {
          await savePairing(pr);
          setNotice(null);
          setPairing(pr);
        }}
      />
    );
  else if (open) screen = <SessionScreen client={client} connection={connection} session={open} onBack={() => setOpen(null)} />;
  else
    screen = (
      <SessionsScreen
        client={client}
        connection={connection}
        onOpen={setOpen}
        onUnpair={async () => {
          client.stop();
          await forgetPairing();
          setPairing(null);
        }}
      />
    );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.ground }} edges={['top', 'left', 'right', 'bottom']}>
      <StatusBar style="auto" />
      <View style={{ flex: 1 }}>{screen}</View>
    </SafeAreaView>
  );
}
