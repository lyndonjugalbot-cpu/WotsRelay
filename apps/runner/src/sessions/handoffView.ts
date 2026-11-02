import type { Checkpoint, ProviderErrorCategory, RouteRef } from '@wots/protocol';
import { redact } from '@wots/security';
import type { Store } from '@wots/storage';

// The inspectable handoff record (spec JSON): existing checkpoint field names, with the spec's
// names aliased: originalRequest = objective, modifiedFiles = changedFiles, handoffReason = category.
// Read-only and redacted. File contents and diffs are never included, only paths.
export interface HandoffView {
  checkpointId: string;
  createdAt: string;
  from: RouteRef | null;
  to: RouteRef | null;
  reason: string;
  category: ProviderErrorCategory | null;
  objective: string;
  completedSteps: string[];
  pendingSteps: string[];
  changedFiles: Array<{ path: string; change: 'added' | 'modified' | 'deleted' }>;
  gitStatus: string[];
  testsExecuted: string[];
  knownErrors: string[];
  unresolvedActions: Checkpoint['unresolvedActions'];
  permissionProfile: Checkpoint['permissionProfile'];
}

export function handoffView(cp: Checkpoint): HandoffView {
  return {
    checkpointId: cp.id,
    createdAt: cp.createdAt,
    from: cp.previousProvider ? { connectionId: cp.previousProvider.connectionId, modelId: cp.previousProvider.model } : null,
    to: cp.nextRoute,
    reason: redact(cp.switchReason ?? ''),
    category: cp.handoffCategory,
    objective: redact(cp.objective),
    completedSteps: cp.completedSteps.map(redact),
    pendingSteps: cp.pendingSteps.map(redact),
    changedFiles: cp.changedFiles.map((f) => ({ path: f.path, change: f.change })),
    gitStatus: cp.gitStatus.map(redact),
    testsExecuted: cp.testEvidence.map(redact),
    knownErrors: cp.knownErrors.map(redact),
    unresolvedActions: cp.unresolvedActions.map((a) => ({ ...a, argsPreview: redact(a.argsPreview) })),
    permissionProfile: cp.permissionProfile,
  };
}

export function handoffViewFor(store: Pick<Store, 'latestCheckpoint'>, sessionId: string): HandoffView | null {
  const cp = store.latestCheckpoint(sessionId);
  return cp ? handoffView(cp) : null;
}
