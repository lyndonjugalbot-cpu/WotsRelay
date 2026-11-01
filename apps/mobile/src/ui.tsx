import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { ConnectionState } from './relay/client.ts';
import { layout, space, type, usePalette, type Palette } from './theme.ts';

export function Button(props: { label: string; onPress(): void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; busy?: boolean; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  const kind = props.kind ?? 'primary';
  const bg = kind === 'primary' ? p.focus : kind === 'danger' ? p.failed : 'transparent';
  const fg = kind === 'secondary' ? p.ink : '#FFFFFF';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!props.disabled, busy: !!props.busy }}
      disabled={props.disabled || props.busy}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: kind === 'secondary' ? p.hairline : bg, opacity: props.disabled ? 0.45 : pressed ? 0.8 : 1 },
        props.style,
      ]}
    >
      {props.busy ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{props.label}</Text>}
    </Pressable>
  );
}

const STATE_TEXT: Record<ConnectionState, string> = { online: 'Connected', connecting: 'Connecting…', offline: 'Reconnecting…', revoked: 'Unpaired' };

export function ConnectionPill({ state }: { state: ConnectionState }) {
  const p = usePalette();
  const tone = state === 'online' ? p.ok : state === 'revoked' ? p.failed : p.paused;
  return (
    <View accessibilityLabel={`Mac connection: ${STATE_TEXT[state]}`} style={[styles.pill, { borderColor: tone }]}>
      <View style={[styles.dot, { backgroundColor: tone }]} />
      <Text style={[styles.pillText, { color: p.ink }]}>{STATE_TEXT[state]}</Text>
    </View>
  );
}

export type UsageWindow = { scope: string; percent: number; resetAt: string | null };

export function UsageRow({ label, lane, windows, switchAt }: { label: string; lane: string; windows: UsageWindow[]; switchAt: number }) {
  const p = usePalette();
  const live = windows.filter((w) => !w.resetAt || Date.parse(w.resetAt) > Date.now());
  return (
    <View style={styles.usageRow}>
      <Text style={[styles.usageLabel, { color: lane }]}>{label}</Text>
      {live.length ? (
        live.map((w) => (
          <View key={w.scope} style={styles.usageWindow} accessibilityLabel={`${label} ${windowName(w.scope)} limit ${w.percent} percent used`}>
            <Text style={[styles.small, { color: p.graphite, width: 52 }]}>{windowName(w.scope)}</Text>
            <View style={[styles.track, { backgroundColor: p.hairline }]}>
              <View style={[styles.fill, { width: `${Math.min(100, w.percent)}%`, backgroundColor: w.percent >= switchAt ? p.failed : w.percent >= 80 ? p.paused : p.ok }]} />
            </View>
            <Text style={[styles.small, { color: p.ink, width: 40, textAlign: 'right' }]}>{w.percent}%</Text>
          </View>
        ))
      ) : (
        <Text style={[styles.small, { color: p.graphite }]}>Not reported yet</Text>
      )}
    </View>
  );
}

export function windowName(scope: string): string {
  return ({ five_hour: '5-hour', seven_day: 'Weekly' } as Record<string, string>)[scope] ?? scope;
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  return <View style={[styles.card, { backgroundColor: p.raised, borderColor: p.hairline }, style]}>{children}</View>;
}

export function textStyles(p: Palette) {
  return {
    title: { fontSize: type.size.lg, fontWeight: '700' as const, color: p.ink },
    body: { fontSize: type.size.base, lineHeight: type.size.base * type.leading.body, color: p.ink },
    small: { fontSize: type.size.xs, color: p.graphite },
    mono: { fontFamily: 'Menlo', fontSize: type.size.xs, color: p.graphite },
  };
}

const styles = StyleSheet.create({
  button: { minHeight: layout.touchTarget, paddingHorizontal: space[4], borderRadius: layout.radius.control, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: type.size.base, fontWeight: '600' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: layout.radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { fontSize: type.size.xs, fontWeight: '600' },
  usageRow: { gap: 4 },
  usageLabel: { fontSize: type.size.sm, fontWeight: '700' },
  usageWindow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  track: { flex: 1, height: 8, borderRadius: 4, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4 },
  small: { fontSize: type.size.xs },
  card: { borderWidth: 1, borderRadius: layout.radius.panel, padding: space[4], gap: space[3] },
});
