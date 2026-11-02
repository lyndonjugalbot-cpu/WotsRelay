import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { Project, Session } from '../../../../packages/protocol/src/index.ts';
import { Logo } from '../Logo.tsx';
import type { ConnectionState, RelayClient } from '../relay/client.ts';
import { laneColor, space, type, usePalette } from '../theme.ts';
import { Button, Card, ConnectionPill, textStyles, UsageRow, type UsageWindow } from '../ui.tsx';

type Usage = { switchAtPercent: number; connections: Record<string, UsageWindow[]> };

const NEEDS_YOU = new Set(['awaiting_approval', 'paused_limits', 'paused_auth', 'paused_uncertain']);
const ACTIVE = new Set(['preparing', 'running', 'checkpointing', 'switching']);

export function SessionsScreen({ client, connection, onOpen, onUnpair }: { client: RelayClient; connection: ConnectionState; onOpen(s: Session): void; onUnpair(): void }) {
  const p = usePalette();
  const t = textStyles(p);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [projects, setProjects] = useState<Record<string, Project>>({});
  const [usage, setUsage] = useState<Usage | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, projs, u] = await Promise.all([client.call<Session[]>('sessions.list'), client.call<Project[]>('projects.list'), client.call<Usage>('usage.get')]);
      setSessions(list.filter((s) => s.latestSeq > 0));
      setProjects(Object.fromEntries(projs.map((x) => [x.id, x])));
      setUsage(u);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    if (connection === 'online') void load();
  }, [connection, load]);

  // Every session's events arrive here; refresh the list when something changes state.
  useEffect(() => {
    void client.subscribe('*');
    const off = client.onEvent((e) => {
      if (e.type !== 'run.stateChanged' && e.type !== 'user.message' && e.type !== 'usage.observed') return;
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => void load(), 300);
    });
    return () => {
      off();
      void client.unsubscribe('*');
    };
  }, [client, load]);

  const newChat = async () => {
    try {
      onOpen(await client.call<Session>('sessions.create', { projectId: null, mode: 'real' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const sorted = [...sessions].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));

  return (
    <FlatList
      data={sorted}
      keyExtractor={(s) => s.id}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
      ListHeaderComponent={
        <View style={{ gap: space[4] }}>
          <View style={styles.header}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
              <Logo variant="mark" height={30} />
              <Text style={t.title} accessibilityRole="header">
                WotsRelay
              </Text>
            </View>
            <ConnectionPill state={connection} />
          </View>
          {usage ? (
            <Card>
              <UsageRow label="Claude" lane={laneColor(p, 'claude-code')} windows={usage.connections['claude-code'] ?? []} switchAt={usage.switchAtPercent} />
              <UsageRow label="Codex" lane={laneColor(p, 'codex')} windows={usage.connections.codex ?? []} switchAt={usage.switchAtPercent} />
              <Text style={t.small}>New messages move to the other model at {usage.switchAtPercent}% of any window.</Text>
            </Card>
          ) : null}
          {error ? <Text style={[t.body, { color: p.failed }]}>{error}</Text> : null}
          <Button label="New chat" kind="secondary" onPress={() => void newChat()} disabled={connection !== 'online'} />
        </View>
      }
      ListEmptyComponent={<Text style={[t.body, { color: p.graphite, marginTop: space[4] }]}>No conversations yet. Start one here, or run wots on your Mac.</Text>}
      ItemSeparatorComponent={() => <View style={{ height: space[2] }} />}
      renderItem={({ item }) => <SessionRow session={item} project={item.projectId ? projects[item.projectId] : undefined} onPress={() => onOpen(item)} />}
      ListFooterComponent={
        <Pressable
          accessibilityRole="button"
          style={styles.unpair}
          onPress={() =>
            Alert.alert('Unpair this iPhone?', 'You will need a new pairing link from your Mac to reconnect.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Unpair', style: 'destructive', onPress: onUnpair },
            ])
          }
        >
          <Text style={[t.small, { color: p.failed }]}>Unpair this iPhone</Text>
        </Pressable>
      }
    />
  );
}

function rank(s: Session): number {
  return NEEDS_YOU.has(s.state) ? 0 : ACTIVE.has(s.state) ? 1 : 2;
}

function SessionRow({ session, project, onPress }: { session: Session; project: Project | undefined; onPress(): void }) {
  const p = usePalette();
  const t = textStyles(p);
  const status = NEEDS_YOU.has(session.state)
    ? { text: session.state === 'awaiting_approval' ? 'Needs approval' : 'Paused', tone: p.paused }
    : ACTIVE.has(session.state)
      ? { text: 'Working…', tone: p.focus }
      : session.state === 'failed'
        ? { text: 'Failed', tone: p.failed }
        : null;
  return (
    <Pressable accessibilityRole="button" accessibilityHint="Opens the conversation" onPress={onPress} style={({ pressed }) => [styles.row, { backgroundColor: p.raised, borderColor: p.hairline, opacity: pressed ? 0.8 : 1 }]}>
      <View style={[styles.lane, { backgroundColor: laneColor(p, session.currentConnectionId) }]} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[t.body, { fontWeight: '600' }]} numberOfLines={2}>
          {session.title}
        </Text>
        <Text style={t.small} numberOfLines={1}>
          {session.mode === 'mock' ? <Text style={{ color: p.laneMock, fontWeight: '700' }}>MOCK · </Text> : null}
          {project ? project.name : 'Chat'} · {ago(session.updatedAt)}
        </Text>
      </View>
      {status ? <Text style={[styles.status, { color: status.tone, borderColor: status.tone }]}>{status.text}</Text> : null}
    </Pressable>
  );
}

function ago(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

const styles = StyleSheet.create({
  content: { padding: space[4], gap: space[2] },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[3], borderWidth: 1, borderRadius: 12, padding: space[3], minHeight: 64 },
  lane: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  status: { fontSize: type.size.xs, fontWeight: '700', borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
  unpair: { paddingVertical: space[5], alignItems: 'center' },
});
