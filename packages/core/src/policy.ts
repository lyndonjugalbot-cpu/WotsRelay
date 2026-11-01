import type { Failure, FallbackConfig, RouteRef, RunState } from '@wots/protocol';

export const MAX_THROTTLE_RETRIES = 2;
export const MAX_CONTEXT_RETRIES = 1;

export type FailureDecision =
  | { action: 'fallback'; reason: string }
  | { action: 'retry_same'; delayMs: number; reason: string }
  | { action: 'retry_compacted'; reason: string }
  | { action: 'pause'; state: Extract<RunState, 'paused_limits' | 'paused_auth' | 'paused_uncertain'>; reason: string; offerManualFallback: boolean }
  | { action: 'fail'; reason: string };

export interface DecisionContext {
  config: FallbackConfig;
  throttleRetries: number;
  contextRetries: number;
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
      const base = failure.retryAfterMs ?? 2000 * 2 ** ctx.throttleRetries;
      const jitter = Math.floor(base * 0.25 * ctx.random());
      return { action: 'retry_same', delayMs: Math.min(base + jitter, 60_000), reason: 'Short throttle; retrying' };
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
    case 'transport':
      return { action: 'pause', state: 'paused_uncertain', reason: `Connection to provider lost: ${failure.message}`, offerManualFallback: true };
    case 'unsupported_version':
      return { action: 'fail', reason: failure.message };
    case 'unknown':
    default:
      return { action: 'pause', state: 'paused_uncertain', reason: `Unclassified error: ${failure.message}`, offerManualFallback: false };
  }
}

export interface RouteCandidate {
  route: RouteRef;
  authenticated: boolean;
  billing: 'subscription' | 'api' | 'unknown';
  modelAvailable: boolean;
  coolingDownUntil: number | null;
  isMock: boolean;
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

export type RouteSelection = { route: RouteRef } | { route: null; reasons: string[] };

// Spec §9 step 6 and the fallback invariants: only configured, authenticated, compatible,
// consented routes; each attempted at most once per cycle; never an unapproved billing path.
export function selectNextRoute(input: RouteSelectionInput): RouteSelection {
  const reasons: string[] = [];
  for (const route of input.config.routes) {
    const key = routeKey(route);
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
    return { route };
  }
  return { route: null, reasons };
}
