import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { describeRisk } from '../../../../packages/core/src/shellRisk.ts';
import type { RouteRef, Session } from '../../../../packages/protocol/src/index.ts';
import { applyEvents, emptyTimeline, type Timeline, type TimelineItem } from '../../../../packages/timeline/src/index.ts';
import type { ConnectionState, RelayClient } from '../relay/client.ts';
import { laneColor, space, type, usePalette, type Palette } from '../theme.ts';
import { Button, Card, ConnectionPill, textStyles } from '../ui.tsx';

type View_ = { session: Session; attempts: Array<{ connectionId: string; requestedModel: string }> };

const PAUSED = new Set(['paused_limits', 'paused_auth', 'paused_uncertain']);
const BUSY = new Set(['preparing', 'running', 'awaiting_approval', 'checkpointing', 'switching']);

export function SessionScreen({ client, connection, session, onBack }: { client: RelayClient; connection: ConnectionState; session: Session; onBack(): void }) {
  const p = usePalette();
  const t = textStyles(p);
  const [timeline, setTimeline] = useState<Timeline>(emptyTimeline);
  const [view, setView] = useState<View_ | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const list = useRef<FlatList<TimelineItem>>(null);

  const refreshView = useCallback(async () => {
    try {
      setView(await client.call<View_>('sessions.get', { sessionId: session.id }));
    } catch {
      /* shown through the connection pill */
    }
  }, [client, session.id]);

  useEffect(() => {
    const off = client.onEvent((e) => {
      if (e.sessionId !== session.id) return;
      setTimeline((cur) => applyEvents(cur, [e]));
      if (e.type === 'run.stateChanged') void refreshView();
    });
    void client.subscribe(session.id, 0);
    void refreshView();
    return () => {
      off();
      void client.unsubscribe(session.id);
    };
  }, [client, session.id, refreshView]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setError(null);
    setActing(key);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
    }
  };

  const state = timeline.state ?? view?.session.state ?? 'idle';
  const busy = BUSY.has(state);
  const paused = PAUSED.has(state);
  const routes = view?.session.fallback.routes ?? session.fallback.routes;
  const last = view?.attempts.at(-1);
  const current: RouteRef = last ? { connectionId: last.connectionId, modelId: last.requestedModel } : routes[0]!;
  const next = routes.find((r) => r.connectionId !== current.connectionId);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    void act('send', async () => {
      await client.call('messages.send', { sessionId: session.id, text, idempotencyKey: `phone-${Date.now()}-${Math.random().toString(36).slice(2)}` });
      setDraft('');
    });
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={8}>
      <View style={[styles.header, { borderColor: p.hairline }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to conversations" onPress={onBack} hitSlop={12} style={styles.back}>
          <Text style={[t.body, { color: p.focus }]}>‹ Back</Text>
        </Pressable>
        <Text style={[t.body, { flex: 1, fontWeight: '600' }]} numberOfLines={1}>
          {session.mode === 'mock' ? <Text style={{ color: p.laneMock }}>MOCK · </Text> : null}
          {view?.session.title ?? session.title}
        </Text>
        <ConnectionPill state={connection} />
      </View>

      <FlatList
        ref={list}
        data={timeline.items}
        keyExtractor={(i) => `${i.kind}:${i.id}`}
        contentContainerStyle={styles.items}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={<Text style={[t.body, { color: p.graphite }]}>Send a message to start.</Text>}
        renderItem={({ item }) => (
          <Item
            item={item}
            palette={p}
            acting={acting}
            onDecide={(decision) =>
              item.kind === 'approval' && void act(`approval:${item.id}`, () => client.call('approvals.decide', { approvalId: item.id, decision, expectedVersion: item.version }))
            }
          />
        )}
      />

      {paused ? (
        <Card style={styles.pauseCard}>
          <Text style={[t.body, { fontWeight: '600' }]}>The reply is paused</Text>
          <Text style={t.small}>{lastReason(timeline) ?? 'Choose how to continue.'}</Text>
          <View style={styles.row}>
            {next && state !== 'paused_auth' ? (
              <Button style={{ flex: 1 }} label={`Continue with ${next.modelId}`} busy={acting === 'next'} onPress={() => void act('next', () => client.call('runs.resume', { sessionId: session.id, fallback: true }))} />
            ) : null}
            <Button style={{ flex: 1 }} kind="secondary" label="Retry" busy={acting === 'retry'} onPress={() => void act('retry', () => client.call('runs.resume', { sessionId: session.id, fallback: false }))} />
          </View>
        </Card>
      ) : null}

      {error ? <Text style={[t.small, styles.error, { color: p.failed }]}>{error}</Text> : null}

      <View style={[styles.composer, { borderColor: p.hairline, backgroundColor: p.surface }]}>
        <TextInput
          accessibilityLabel="Message"
          value={draft}
          onChangeText={setDraft}
          placeholder={busy ? 'Working…' : paused ? 'Paused — continue above first' : `Message ${current.modelId}`}
          placeholderTextColor={p.graphite}
          multiline
          editable={!paused}
          style={[styles.input, { color: p.ink }]}
        />
        {busy && timeline.activeRunId ? (
          <Button kind="danger" label="Stop" busy={acting === 'stop'} onPress={() => void act('stop', () => client.call('runs.interrupt', { runId: timeline.activeRunId }))} />
        ) : (
          <Button label="Send" disabled={!draft.trim() || paused || connection !== 'online'} busy={acting === 'send'} onPress={send} />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

// Phones are narrow: the last two folders identify a project well enough.
function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}

function lastReason(t: Timeline): string | null {
  for (let i = t.items.length - 1; i >= 0; i--) {
    const it = t.items[i]!;
    if (it.kind === 'state' && it.reason) return it.reason;
  }
  return null;
}

function Item({ item, palette: p, acting, onDecide }: { item: TimelineItem; palette: Palette; acting: string | null; onDecide(d: 'approve' | 'approve_session' | 'reject'): void }) {
  const t = textStyles(p);
  switch (item.kind) {
    case 'user':
      return (
        <View style={[styles.bubble, styles.mine, { backgroundColor: p.focus }]}>
          <Text style={[t.body, { color: '#FFFFFF' }]}>{item.text}</Text>
        </View>
      );
    case 'assistant':
      return (
        <View style={[styles.bubble, { backgroundColor: p.raised, borderColor: p.hairline, borderWidth: 1, borderLeftColor: laneColor(p, item.connectionId), borderLeftWidth: 3 }]}>
          <Text style={[styles.speaker, { color: laneColor(p, item.connectionId) }]}>{item.model ?? item.connectionId ?? 'assistant'}</Text>
          <Text style={t.body} selectable>
            {item.text}
            {!item.done ? ' ▍' : ''}
          </Text>
          {item.interrupted ? <Text style={[t.small, { color: p.paused }]}>Interrupted</Text> : null}
        </View>
      );
    case 'tool':
      return (
        <Text style={t.mono} numberOfLines={2}>
          {item.status === 'denied' ? '⊘' : item.status === 'failed' ? '!' : '⚙'} {item.name} {item.preview}
        </Text>
      );
    case 'handoff':
      return (
        <Text style={[t.small, styles.centered, { color: p.paused }]}>
          ⇄ Continuing with {item.toModel} — {item.reason}
        </Text>
      );
    case 'approval': {
      const pending = item.status === 'pending';
      const tone = item.risk === 'external-side-effect' ? p.failed : item.risk === 'read-only' ? p.ok : p.paused;
      return (
        <Card style={{ borderColor: pending ? tone : p.hairline }}>
          <Text style={[t.small, { color: tone, fontWeight: '700' }]}>{pending ? 'Approval needed' : `Approval: ${item.status === 'approve' ? 'approved' : item.status === 'reject' ? 'rejected' : 'expired'}`} · {describeRisk(item.risk)}</Text>
          <Text style={[t.mono, { color: p.ink }]} selectable>
            {item.action}
          </Text>
          <Text style={t.small} numberOfLines={1}>
            in {shortPath(item.scope)}
          </Text>
          {pending ? (
            <View style={{ gap: space[2] }}>
              <View style={styles.row}>
                <Button style={{ flex: 1 }} label="Approve" busy={acting === `approval:${item.id}`} onPress={() => onDecide('approve')} />
                <Button style={{ flex: 1 }} kind="danger" label="Reject" onPress={() => onDecide('reject')} />
              </View>
              {item.canApproveForSession ? <Button kind="secondary" label="Approve for this session" onPress={() => onDecide('approve_session')} /> : null}
            </View>
          ) : null}
        </Card>
      );
    }
    case 'state':
      return (
        <Text style={[t.small, styles.centered, { color: item.state === 'failed' ? p.failed : p.paused }]}>
          {item.state.replace('_', ' ')}
          {item.reason ? ` — ${item.reason}` : ''}
        </Text>
      );
    case 'notice':
      return <Text style={[t.small, styles.centered, { color: item.level === 'error' ? p.failed : p.graphite }]}>{item.text}</Text>;
  }
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: space[3], paddingHorizontal: space[4], paddingVertical: space[2], borderBottomWidth: 1 },
  back: { minHeight: 44, justifyContent: 'center' },
  items: { padding: space[4], gap: space[3] },
  bubble: { borderRadius: 14, padding: space[3], maxWidth: '92%', gap: 4 },
  mine: { alignSelf: 'flex-end' },
  speaker: { fontSize: type.size.xs, fontWeight: '700' },
  centered: { textAlign: 'center' },
  row: { flexDirection: 'row', gap: space[2] },
  pauseCard: { marginHorizontal: space[4], marginBottom: space[2] },
  error: { paddingHorizontal: space[4], paddingBottom: space[2] },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: space[2], padding: space[3], borderTopWidth: 1 },
  input: { flex: 1, minHeight: 44, maxHeight: 140, fontSize: type.size.base, paddingTop: 12 },
});
