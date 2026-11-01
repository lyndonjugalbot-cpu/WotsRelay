// Shared WotsRelay tokens for desktop (CSS variables) and the phone companion (React Native).
// Provider identity is carried by lane colours; they are WotsRelay's own, not provider brand assets.

export const color = {
  light: {
    ground: '#EDF0F3', // Fog
    surface: '#F8FAFB',
    raised: '#FFFFFF',
    ink: '#1B2433',
    graphite: '#5A6577',
    hairline: '#D5DBE2',
    laneA: '#2B5BD7',
    laneB: '#0B8A80',
    laneMock: '#8A6A2E',
    paused: '#A86A00',
    failed: '#B4322A',
    ok: '#2E7D4F',
    focus: '#2B5BD7',
  },
  dark: {
    ground: '#141C2C', // Night track
    surface: '#1A2336',
    raised: '#222D44',
    ink: '#E6EBF2',
    graphite: '#97A3B6',
    hairline: '#2E3A52',
    laneA: '#7C9DFF',
    laneB: '#3CC2B5',
    laneMock: '#D1A85A',
    paused: '#E3A53C',
    failed: '#F07A70',
    ok: '#6BCB91',
    focus: '#7C9DFF',
  },
} as const;

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48 } as const;

// Modular scale (ratio 1.2) from a 16 px base.
export const type = {
  family: { ui: '"Atkinson Hyperlegible Next Variable", "Atkinson Hyperlegible Next", system-ui, sans-serif', code: '"IBM Plex Mono", ui-monospace, monospace' },
  size: { xs: 13, sm: 14, base: 16, md: 19, lg: 23, xl: 28 },
  leading: { tight: 1.25, body: 1.55, code: 1.5 },
} as const;

export const layout = { sidebar: 260, conversation: 820, activity: 360, touchTarget: 44, radius: { control: 8, panel: 12, pill: 999 } } as const;

export function laneFor(connectionId: string | null, isMock = false): 'laneA' | 'laneB' | 'laneMock' {
  if (isMock || connectionId?.startsWith('mock-')) return connectionId === 'mock-codex' ? 'laneB' : 'laneA';
  return connectionId === 'codex' ? 'laneB' : 'laneA';
}
