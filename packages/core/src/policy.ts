import type { Failure, FailureKind, FallbackConfig, ProviderErrorCategory, RouteRef, RunState } from '@wots/protocol';

export const MAX_THROTTLE_RETRIES = 2;
export const MAX_CONTEXT_RETRIES = 1;

export type FailureDecision =
  | { action: 'fallback'; reason: string }
  | { action: 'retry_same'; delayMs: number; reason: string }
  | { action: 'retry_compacted'; reason: string }
  | { action: 'pause'; state: Extract<RunState, 'paused_limits' | 'paused_auth' | 'paused_uncertain'>; reason: string; offerManualFallback: boolean }
  | { action: 'fail'; reason: string };

// Pure display mapping from the stored failure kind to the spec's category. Exhaustive: a new
// FailureKind fails typecheck here until it is placed.
export function categoryOf(kind: FailureKind): ProviderErrorCategory {
  switch (kind) {
    case 'transient_throttle':
      return 'RATE_LIMIT';
    case 'usage_limit':
    case 'usage_limit_suspected':
      return 'QUOTA_EXCEEDED';
    case 'auth':
      return 'AUTH_EXPIRED';
    case 'outage':
    case 'model_unavailable':
      return 'PROVIDER_UNAVAILABLE';
    case 'transport':
      return 'NETWORK_ERROR';
    case 'timeout':
      return 'TIMEOUT';
    case 'permission_denied':
    case 'policy_refusal':
      return 'PERMISSION_DENIED';
    case 'context_too_large':
    case 'billing_route_conflict':
    case 'unsupported_version':
      return 'EXECUTION_ERROR';
    case 'unknown':
      return 'UNKNOWN';
  }
}

export const DEFAULT_TRANSPORT_RETRIES = 2;

export interface DecisionContext {
  config: FallbackConfig;
  throttleRetries: number;
  contextRetries: number;
  // Same-route retries already spent on lost connections in this cycle.
  transportRetries?: number;
  // The failed attempt left tool calls without a recorded result; a blind retry could repeat them.
  unresolvedTools?: boolean;
  // Deterministic jitter source so tests can use a fake clock / RNG.
  random: () => number;
}

// Spec §9 signal table. Classification happens in adapters from structured data; this
// maps a classified failure to the default action. It never inspects assistant prose.
export function decide(failure: Failure, ctx: DecisionContext): FailureDecision {
  switch (failure.kind) {
    case 'usage_limit':
      return ctx.config.autoFallback
        ? { action: 'fallback', reason: `Usage limit reached (${failure.evidence})` }
        : { action: 'pause', state: 'paused_limits', reason: 'Usage limit reached; automatic fallback is off', offerManualFallback: true };
    case 'usage_limit_suspected':
      return {
        action: 'pause',
        state: 'paused_uncertain',
        reason: `Possible usage limit, not confirmed by a structured signal (${failure.evidence}). Confirm to continue with the next provider.`,
        offerManualFallback: true,
      };
    case 'transient_throttle': {
      if (ctx.throttleRetries >= MAX_THROTTLE_RETRIES) {
        return { action: 'pause', state: 'paused_limits', reason: 'Provider is throttling; retries exhausted', offerManualFallback: true };
      }
      return { action: 'retry_same', delayMs: throttleDelay(ctx.throttleRetries, failure.retryAfterMs, ctx.random), reason: 'Short throttle; retrying' };
    }
    case 'outage':
      return ctx.config.outageFallback
        ? { action: 'fallback', reason: `Provider outage (${failure.evidence})` }
        : { action: 'pause', state: 'paused_limits', reason: 'Provider appears unavailable; outage fallback is off', offerManualFallback: true };
    case 'auth':
      return { action: 'pause', state: 'paused_auth', reason: 'Authentication needs attention in the provider’s own sign-in flow', offerManualFallback: false };
    case 'billing_route_conflict':
      return { action: 'pause', state: 'paused_auth', reason: failure.message, offerManualFallback: false };
    case 'model_unavailable':
      return { action: 'pause', state: 'paused_uncertain', reason: `Requested model unavailable: ${failure.message}. Choose a replacement explicitly.`, offerManualFallback: false };
    case 'context_too_large':
      return ctx.contextRetries < MAX_CONTEXT_RETRIES
        ? { action: 'retry_compacted', reason: 'Context too large; retrying once with compacted context' }
        : { action: 'pause', state: 'paused_uncertain', reason: 'Context still too large after compaction', offerManualFallback: false };
    case 'permission_denied':
    case 'policy_refusal':
      // Never switch providers to get around a boundary.
      return { action: 'fail', reason: `${failure.kind === 'permission_denied' ? 'Permission denied' : 'Policy refusal'}: ${failure.message}` };
    case 'transport': {
      const used = ctx.transportRetries ?? 0;
      if (!ctx.unresolvedTools && used < (ctx.config.transportRetries ?? DEFAULT_TRANSPORT_RETRIES)) {
        return { action: 'retry_same', delayMs: throttleDelay(used, null, ctx.random), reason: 'Connection to provider lost; retrying the same route' };
      }
      return { action: 'pause', state: 'paused_uncertain', reason: `Connection to provider lost: ${failure.message}`, offerManualFallback: true };
    }
    case 'timeout':
      return { action: 'pause', state: 'paused_uncertain', reason: `The attempt timed out: ${failure.message}`, offerManualFallback: true };
    case 'unsupported_version':
      return { action: 'fail', reason: failure.message };
    case 'unknown':
    default:
      return { action: 'pause', state: 'paused_uncertain', reason: `Unclassified error: ${failure.message}`, offerManualFallback: false };
  }
}

// Exponential backoff with up to 25% jitter, capped at a minute. A provider's own retry-after wins.
export function throttleDelay(retries: number, retryAfterMs: number | null, random: () => number): number {
  const base = retryAfterMs ?? 2000 * 2 ** retries;
  const jitter = Math.floor(base * 0.25 * random());
  return Math.min(base + jitter, 60_000);
}

export interface RouteCandidate {
  route: RouteRef;
  authenticated: boolean;
  billing: 'subscription' | 'api' | 'unknown';
  modelAvailable: boolean;
  coolingDownUntil: number | null;
  isMock: boolean;
  // Latest provider-reported usage per window (e.g. five_hour, seven_day) for this connection.
  usage?: UsageWindow[];
}

export interface UsageWindow {
  scope: string;
  percent: number;
  resetAt: number | null;
}

export const DEFAULT_SWITCH_AT_PERCENT = 95;

// The fullest window still at or over the threshold. A window whose reset time has passed no
// longer counts, so the preferred route comes back on its own after the reset.
export function nearLimit(usage: readonly UsageWindow[] | undefined, threshold: number, now: number): UsageWindow | null {
  let worst: UsageWindow | null = null;
  for (const w of usage ?? []) {
    if (w.percent < threshold || (w.resetAt !== null && w.resetAt <= now)) continue;
    if (!worst || w.percent > worst.percent) worst = w;
  }
  return worst;
}

export function windowLabel(scope: string): string {
  return ({ five_hour: '5-hour', seven_day: 'weekly' } as Record<string, string>)[scope] ?? scope;
}

export interface RouteSelectionInput {
  config: FallbackConfig;
  candidates: RouteCandidate[];
  // Routes already attempted in the current fallback cycle (connectionId:modelId).
  tried: ReadonlySet<string>;
  crossProviderConsent: boolean;
  currentConnectionId: string | null;
  now: number;
  // Mock routes are only eligible when the session was explicitly created in mock mode.
  allowMock: boolean;
}

export function routeKey(r: RouteRef): string {
  return `${r.connectionId}:${r.modelId}`;
}

export type RouteSelection =
  | { route: RouteRef; reason?: string; skipped?: { route: RouteRef; window: UsageWindow } }
  | { route: null; reasons: string[]; reason?: undefined };

// Spec §9 step 6 and the fallback invariants: only configured, authenticated, compatible,
// consented routes; each attempted at most once per cycle; never an unapproved billing path.
export function selectNextRoute(input: RouteSelectionInput): RouteSelection {
  const reasons: string[] = [];
  const threshold = input.config.switchAtPercent ?? DEFAULT_SWITCH_AT_PERCENT;
  const nearlyFull: Array<{ route: RouteRef; window: UsageWindow }> = [];
  const disabled = new Set(input.config.disabledConnections ?? []);
  for (const route of input.config.routes) {
    const key = routeKey(route);
    if (disabled.has(route.connectionId)) {
      reasons.push(`${route.connectionId}: disabled by user`);
      continue;
    }
    if (input.tried.has(key)) {
      reasons.push(`${key}: already tried this cycle`);
      continue;
    }
    const c = input.candidates.find((x) => routeKey(x.route) === key);
    if (!c) {
      reasons.push(`${key}: not configured`);
      continue;
    }
    if (c.isMock && !input.allowMock) {
      reasons.push(`${key}: mock route not allowed for a real session`);
      continue;
    }
    if (!c.authenticated) {
      reasons.push(`${key}: not authenticated`);
      continue;
    }
    if (!c.modelAvailable) {
      reasons.push(`${key}: model unavailable`);
      continue;
    }
    if (c.billing === 'api' && !input.config.allowApiBilling) {
      reasons.push(`${key}: API billing not enabled by the user`);
      continue;
    }
    if (c.coolingDownUntil !== null && c.coolingDownUntil > input.now) {
      reasons.push(`${key}: cooling down until ${new Date(c.coolingDownUntil).toISOString()}`);
      continue;
    }
    if (input.currentConnectionId !== null && route.connectionId !== input.currentConnectionId && !input.crossProviderConsent) {
      reasons.push(`${key}: project has not consented to cross-provider context sharing`);
      continue;
    }
    const full = nearLimit(c.usage, threshold, input.now);
    if (full) {
      reasons.push(`${key}: ${full.percent}% of the ${windowLabel(full.scope)} limit used`);
      nearlyFull.push({ route, window: full });
      continue;
    }
    if (nearlyFull.length) {
      const first = nearlyFull[0]!;
      return { route, reason: `${first.route.modelId} is at ${first.window.percent}% of its ${windowLabel(first.window.scope)} limit${resetText(first.window.resetAt)}`, skipped: first };
    }
    return { route };
  }
  // Every usable route is close to its limit: keep working on the one with the most room left.
  if (nearlyFull.length) {
    const best = [...nearlyFull].sort((a, b) => a.window.percent - b.window.percent)[0]!;
    return { route: best.route, reason: `All routes are near their limits; using ${best.route.modelId} (${best.window.percent}% used)` };
  }
  return { route: null, reasons };
}

// The user's chosen model goes first. Routes on other connections keep their order as the
// fallback; the chosen connection's previous model is dropped so one provider never falls
// back to itself by surprise.
export function promoteRoute(routes: readonly RouteRef[], chosen: RouteRef): RouteRef[] {
  return [chosen, ...routes.filter((r) => r.connectionId !== chosen.connectionId)];
}

function resetText(resetAt: number | null): string {
  if (resetAt === null) return '';
  return `, resets ${new Date(resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
