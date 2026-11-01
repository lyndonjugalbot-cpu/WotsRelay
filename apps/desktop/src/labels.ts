const ROUTES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', 'mock-claude': 'Mock Claude', 'mock-codex': 'Mock Codex' };
const MODELS: Record<string, string> = { 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'gpt-6-astra': 'GPT-6 Astra' };

export const routeLabel = (id: string | null) => (id ? (ROUTES[id] ?? id) : 'Assistant');
export const modelLabel = (id: string | null) => (id ? (MODELS[id] ?? id) : 'Unknown model');
export const lane = (connectionId: string | null): 'a' | 'b' => (connectionId === 'codex' || connectionId === 'mock-codex' ? 'b' : 'a');
export const isMockRoute = (id: string | null) => !!id?.startsWith('mock-');

export const STATE_TEXT: Record<string, string> = {
  idle: 'Ready',
  preparing: 'Preparing',
  running: 'Working',
  checkpointing: 'Saving checkpoint',
  switching: 'Handing off',
  awaiting_approval: 'Waiting for your approval',
  paused_limits: 'Paused: usage limits',
  paused_auth: 'Paused: sign-in needed',
  paused_uncertain: 'Paused: needs your review',
  completed: 'Done',
  cancelled: 'Stopped',
  failed: 'Failed',
};

export function relativeTime(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
