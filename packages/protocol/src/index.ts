// WotsRelay-owned contracts (spec §7). These are not vendor SDK signatures.
// Every persisted or externally received message is validated against these schemas.
import { z } from 'zod';

export const SCHEMA_VERSION = 1;
export const PROTOCOL_VERSION = 1;

export const Id = z.string().min(1).max(128);
export const IsoTime = z.string().datetime();

export const Provider = z.enum(['anthropic', 'openai', 'mock']);
export type Provider = z.infer<typeof Provider>;

export const AdapterKind = z.enum(['claude-code-cli', 'codex-app-server', 'mock']);
export type AdapterKind = z.infer<typeof AdapterKind>;

export const BillingMode = z.enum(['subscription', 'api', 'unknown']);
export type BillingMode = z.infer<typeof BillingMode>;

export const Effort = z.enum(['low', 'medium', 'high']);
export type Effort = z.infer<typeof Effort>;

export const Speed = z.enum(['standard']);
export type Speed = z.infer<typeof Speed>;

export const VerificationStatus = z.enum(['verified', 'listed-unverified', 'unavailable', 'unknown']);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

export const AuthStatus = z.enum(['authenticated', 'unauthenticated', 'expired', 'unknown', 'not-installed']);
export type AuthStatus = z.infer<typeof AuthStatus>;

export const ModelCapability = z.object({
  modelId: z.string(),
  displayName: z.string(),
  supportedEfforts: z.array(z.string()),
  speedOptions: z.array(z.string()),
  inputModalities: z.array(z.string()).default(['text']),
  contextLimit: z.number().int().positive().nullable(),
  verification: VerificationStatus,
  verifiedAt: IsoTime.nullable(),
  source: z.string(),
});
export type ModelCapability = z.infer<typeof ModelCapability>;

export const Connection = z.object({
  id: Id,
  provider: Provider,
  adapter: AdapterKind,
  adapterVersion: z.string(),
  toolVersion: z.string().nullable(),
  executablePath: z.string().nullable(),
  // A reference such as "native:claude-code" — never a credential value.
  credentialRef: z.string(),
  authStatus: AuthStatus,
  billingMode: BillingMode,
  lastChecked: IsoTime,
  verifiedModels: z.array(z.string()),
  capabilities: z.array(z.string()),
  limitations: z.array(z.string()),
  isMock: z.boolean(),
});
export type Connection = z.infer<typeof Connection>;

export const WorkspaceMode = z.enum(['in-place', 'worktree']);
export const PermissionProfile = z.enum(['chat', 'read-only', 'edit']);
export type PermissionProfile = z.infer<typeof PermissionProfile>;

export const Project = z.object({
  id: Id,
  root: z.string(),
  name: z.string(),
  trusted: z.boolean(),
  workspaceMode: WorkspaceMode,
  permissionProfile: PermissionProfile,
  permissionVersion: z.number().int().nonnegative(),
  contextExclusions: z.array(z.string()),
  crossProviderConsent: z.boolean(),
  createdAt: IsoTime,
});
export type Project = z.infer<typeof Project>;

export const RunState = z.enum([
  'idle',
  'preparing',
  'running',
  'checkpointing',
  'switching',
  'awaiting_approval',
  'paused_limits',
  'paused_auth',
  'paused_uncertain',
  'completed',
  'cancelled',
  'failed',
]);
export type RunState = z.infer<typeof RunState>;

export const RouteRef = z.object({
  connectionId: Id,
  modelId: z.string(),
});
export type RouteRef = z.infer<typeof RouteRef>;

export const FallbackConfig = z.object({
  routes: z.array(RouteRef).min(1),
  effort: Effort,
  speed: Speed,
  autoFallback: z.boolean(),
  outageFallback: z.boolean(),
  allowApiBilling: z.boolean(),
  // Prefer the next route once a provider reports this share of a usage window as used.
  switchAtPercent: z.number().int().min(50).max(100).default(95),
});
export type FallbackConfig = z.infer<typeof FallbackConfig>;

export const Session = z.object({
  id: Id,
  projectId: Id.nullable(),
  title: z.string(),
  objective: z.string(),
  fallback: FallbackConfig,
  // Mock sessions may only use mock routes, and real sessions only real routes.
  mode: z.enum(['real', 'mock']),
  currentConnectionId: Id.nullable(),
  state: RunState,
  latestSeq: z.number().int().nonnegative(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
});
export type Session = z.infer<typeof Session>;

export const Run = z.object({
  id: Id,
  sessionId: Id,
  userMessageId: Id,
  state: RunState,
  stateReason: z.string().nullable(),
  activeAttemptId: Id.nullable(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
});
export type Run = z.infer<typeof Run>;

export const Attempt = z.object({
  id: Id,
  runId: Id,
  connectionId: Id,
  provider: Provider,
  requestedModel: z.string(),
  effectiveModel: z.string().nullable(),
  requestedEffort: Effort,
  effectiveEffort: z.string().nullable(),
  providerSessionId: z.string().nullable(),
  parentAttemptId: Id.nullable(),
  startedAt: IsoTime,
  endedAt: IsoTime.nullable(),
  termination: z.string().nullable(),
  retryCount: z.number().int().nonnegative(),
});
export type Attempt = z.infer<typeof Attempt>;

// approve_session: also allow matching requests for the rest of the provider session (Codex
// `acceptForSession`; offered only when the request says it is supported).
export const ApprovalDecision = z.enum(['approve', 'approve_session', 'reject']);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const RiskCategory = z.enum(['read-only', 'reversible-local-write', 'external-side-effect', 'unknown']);
export type RiskCategory = z.infer<typeof RiskCategory>;

export const ToolStatus = z.enum(['started', 'completed', 'failed', 'unknown', 'denied']);
export type ToolStatus = z.infer<typeof ToolStatus>;

export const ToolAction = z.object({
  operationId: Id,
  attemptId: Id,
  providerToolId: z.string(),
  name: z.string(),
  argsHash: z.string(),
  argsPreview: z.string(),
  risk: RiskCategory,
  cwd: z.string().nullable(),
  approvalId: Id.nullable(),
  paths: z.array(z.string()),
  status: ToolStatus,
  resultDigest: z.string().nullable(),
  startedAt: IsoTime,
  endedAt: IsoTime.nullable(),
});
export type ToolAction = z.infer<typeof ToolAction>;

// Failure taxonomy (spec §9). Adapters must produce one of these from structured evidence.
export const FailureKind = z.enum([
  'usage_limit', // confirmed subscription/quota exhaustion
  'usage_limit_suspected', // throttling seen but exhaustion not proven
  'transient_throttle',
  'outage',
  'auth',
  'model_unavailable',
  'context_too_large',
  'permission_denied',
  'policy_refusal',
  'transport',
  'billing_route_conflict',
  'unsupported_version',
  'unknown',
]);
export type FailureKind = z.infer<typeof FailureKind>;

export const Failure = z.object({
  kind: FailureKind,
  message: z.string(),
  retryAfterMs: z.number().int().nonnegative().nullable().default(null),
  resetAt: IsoTime.nullable().default(null),
  scope: z.string().nullable().default(null),
  // Name of the structured signal that produced the classification, e.g. "codexErrorInfo=usageLimitExceeded".
  evidence: z.string(),
  simulated: z.boolean().default(false),
});
export type Failure = z.infer<typeof Failure>;

export const FileEntry = z.object({ path: z.string(), sha256: z.string(), size: z.number().int() });
export type FileEntry = z.infer<typeof FileEntry>;

export const UnresolvedAction = z.object({
  operationId: Id,
  name: z.string(),
  argsPreview: z.string(),
  risk: RiskCategory,
  status: ToolStatus,
});

export const Checkpoint = z.object({
  id: Id,
  sessionId: Id,
  runId: Id,
  objective: z.string(),
  latestUserConstraints: z.array(z.string()),
  completedSteps: z.array(z.string()),
  pendingSteps: z.array(z.string()),
  decisionNotes: z.array(z.string()),
  recentMessages: z.array(z.object({ role: z.enum(['user', 'assistant']), provider: z.string().nullable(), model: z.string().nullable(), text: z.string(), interrupted: z.boolean() })),
  baselineCommit: z.string().nullable(),
  fileManifest: z.array(FileEntry),
  changedFiles: z.array(z.object({ path: z.string(), change: z.enum(['added', 'modified', 'deleted']), sha256: z.string().nullable() })),
  diff: z.string(),
  testEvidence: z.array(z.string()),
  providerBindings: z.record(z.string(), z.string()),
  unresolvedActions: z.array(UnresolvedAction),
  permissionVersion: z.number().int(),
  switchReason: z.string().nullable(),
  previousProvider: z.object({ connectionId: z.string(), model: z.string() }).nullable(),
  createdAtSeq: z.number().int(),
  contentHash: z.string(),
  createdAt: IsoTime,
});
export type Checkpoint = z.infer<typeof Checkpoint>;

export const UsageObservation = z.object({
  provider: Provider,
  connectionId: Id,
  scope: z.string(),
  source: z.string(),
  observedAt: IsoTime,
  resetAt: IsoTime.nullable(),
  value: z.number().nullable(),
  unit: z.string().nullable(),
  confidence: z.enum(['reported', 'derived', 'unknown']),
});
export type UsageObservation = z.infer<typeof UsageObservation>;

export const PairedDevice = z.object({
  id: Id,
  label: z.string(),
  publicKeyRef: z.string(),
  scopes: z.array(z.string()),
  projectIds: z.array(Id),
  lastSeen: IsoTime.nullable(),
  revokedAt: IsoTime.nullable(),
  createdAt: IsoTime,
});
export type PairedDevice = z.infer<typeof PairedDevice>;

// ---- Events -------------------------------------------------------------------------------

const ProviderTag = z.object({ connectionId: Id.nullable(), provider: Provider.nullable(), model: z.string().nullable() });

export const EventPayloads = {
  'user.message': z.object({ messageId: Id, text: z.string() }),
  'message.delta': ProviderTag.extend({ messageId: Id, text: z.string() }),
  'message.completed': ProviderTag.extend({ messageId: Id, text: z.string() }),
  'message.interrupted': ProviderTag.extend({ messageId: Id, text: z.string(), reason: z.string() }),
  'tool.started': z.object({ operationId: Id, name: z.string(), argsPreview: z.string(), risk: RiskCategory, paths: z.array(z.string()) }),
  'tool.completed': z.object({ operationId: Id, resultDigest: z.string().nullable() }),
  'tool.failed': z.object({ operationId: Id, message: z.string() }),
  'tool.unknown': z.object({ operationId: Id, message: z.string() }),
  'tool.denied': z.object({ operationId: Id, message: z.string() }),
  'approval.requested': z.object({ approvalId: Id, operationId: Id.nullable(), action: z.string(), scope: z.string(), risk: RiskCategory, version: z.number().int(), canApproveForSession: z.boolean().default(false) }),
  'approval.resolved': z.object({ approvalId: Id, decision: ApprovalDecision, deviceId: z.string(), version: z.number().int() }),
  'limit.observed': z.object({ failure: Failure }),
  'checkpoint.created': z.object({ checkpointId: Id, contentHash: z.string(), changedFiles: z.number().int(), omitted: z.array(z.string()) }),
  'provider.switched': z.object({ from: RouteRef, to: RouteRef, reason: z.string(), simulated: z.boolean() }),
  'run.stateChanged': z.object({ from: RunState, to: RunState, reason: z.string().nullable() }),
  'usage.observed': z.object({ observation: UsageObservation }),
  'model.effective': z.object({ requested: z.string(), effective: z.string(), effort: z.string().nullable(), note: z.string().nullable() }),
  'attempt.started': z.object({ connectionId: Id, provider: Provider, model: z.string(), parentAttemptId: Id.nullable(), isMock: z.boolean() }),
  'attempt.ended': z.object({ termination: z.string(), quiescent: z.boolean() }),
  'diagnostic': z.object({ level: z.enum(['info', 'warn', 'error']), message: z.string() }),
} as const;

export type EventType = keyof typeof EventPayloads;
export const EventTypes = Object.keys(EventPayloads) as EventType[];
export type EventPayload<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;

export const EventEnvelope = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  sessionId: Id,
  runId: Id.nullable(),
  attemptId: Id.nullable(),
  seq: z.number().int().positive(),
  eventId: Id,
  ts: IsoTime,
  type: z.enum(EventTypes as [EventType, ...EventType[]]),
  payload: z.unknown(),
});
export type EventEnvelope = Omit<z.infer<typeof EventEnvelope>, 'payload'> & { payload: unknown };

export type TypedEvent<T extends EventType = EventType> = Omit<EventEnvelope, 'type' | 'payload'> & {
  type: T;
  payload: EventPayload<T>;
};

export function parsePayload<T extends EventType>(type: T, payload: unknown): EventPayload<T> {
  return EventPayloads[type].parse(payload) as EventPayload<T>;
}

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(['completed', 'cancelled', 'failed']);
export const PAUSED_STATES: ReadonlySet<RunState> = new Set(['paused_limits', 'paused_auth', 'paused_uncertain']);

// ---- Local RPC (runner <-> desktop/CLI over the user-only Unix socket) --------------------

export const RpcRequest = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.union([z.string(), z.number()]),
  method: z.string().max(64),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export type RpcResponse =
  | { v: 1; id: string | number; result: unknown }
  | { v: 1; id: string | number; error: { code: string; message: string } };

export type RpcNotification = { v: 1; method: 'event'; params: EventEnvelope };

export const MAX_FRAME_BYTES = 1_000_000;

export const SendMessageParams = z.object({
  sessionId: Id,
  text: z.string().min(1).max(200_000),
  idempotencyKey: z.string().min(8).max(128),
});

export const CreateSessionParams = z.object({
  projectId: Id.nullable(),
  title: z.string().max(200).optional(),
});

export const RegisterProjectParams = z.object({
  root: z.string().min(1),
  trusted: z.boolean(),
  permissionProfile: PermissionProfile.default('edit'),
  crossProviderConsent: z.boolean().default(false),
});

export const ApprovalDecisionParams = z.object({
  approvalId: Id,
  decision: ApprovalDecision,
  expectedVersion: z.number().int(),
  deviceId: z.string().default('local'),
});

export const SubscribeParams = z.object({ sessionId: Id, after: z.number().int().nonnegative().default(0) });

export const ExitCodes = {
  completed: 0,
  failed: 1,
  usage: 2,
  runnerUnavailable: 3,
  paused: 10,
  cancelled: 130,
} as const;
