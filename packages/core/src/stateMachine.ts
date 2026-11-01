import type { RunState } from '@wots/protocol';

// Spec §9. Every allowed transition is listed; anything else is a bug and throws.
export const TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  idle: ['preparing', 'cancelled'],
  preparing: ['running', 'paused_auth', 'paused_uncertain', 'failed', 'cancelled'],
  running: ['awaiting_approval', 'checkpointing', 'completed', 'paused_auth', 'paused_uncertain', 'paused_limits', 'failed', 'cancelled', 'running'],
  awaiting_approval: ['running', 'completed', 'cancelled', 'paused_uncertain', 'paused_auth', 'paused_limits', 'failed', 'checkpointing'],
  checkpointing: ['switching', 'paused_limits', 'paused_auth', 'paused_uncertain', 'cancelled', 'failed'],
  switching: ['running', 'paused_limits', 'paused_auth', 'paused_uncertain', 'cancelled', 'failed'],
  paused_limits: ['preparing', 'cancelled'],
  paused_auth: ['preparing', 'cancelled'],
  paused_uncertain: ['preparing', 'checkpointing', 'cancelled'],
  completed: [],
  cancelled: [],
  failed: [],
};

export class InvalidTransitionError extends Error {
  readonly from: RunState;
  readonly to: RunState;

  constructor(from: RunState, to: RunState) {
    super(`Invalid run state transition ${from} -> ${to}`);
    this.from = from;
    this.to = to;
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
