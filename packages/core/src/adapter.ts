import type {
  AdapterKind,
  Connection,
  Effort,
  Failure,
  ModelCapability,
  PermissionProfile,
  Provider,
  RiskCategory,
  UsageObservation,
} from '@wots/protocol';

// Normalized events an adapter emits. The runner assigns WotsRelay IDs/sequence numbers.
export type AdapterEvent =
  | { type: 'session.bound'; providerSessionId: string }
  | { type: 'model.effective'; model: string; effort: string | null; note?: string }
  | { type: 'message.delta'; messageKey: string; text: string }
  | { type: 'message.completed'; messageKey: string; text: string }
  | { type: 'tool.started'; providerToolId: string; name: string; args: unknown; risk: RiskCategory; paths: string[] }
  | { type: 'tool.completed'; providerToolId: string; result?: string }
  | { type: 'tool.failed'; providerToolId: string; message: string }
  | { type: 'tool.denied'; providerToolId: string; message: string }
  | { type: 'approval.requested'; providerRequestId: string; providerToolId: string | null; action: string; scope: string; risk: RiskCategory }
  | { type: 'usage.observed'; observation: Omit<UsageObservation, 'connectionId'> }
  | { type: 'limit.observed'; failure: Failure }
  // Provider-side event id used for deduplication of late/duplicate deliveries.
  | { type: 'diagnostic'; level: 'info' | 'warn' | 'error'; message: string };

export type AdapterEventEnvelope = AdapterEvent & { providerEventId?: string };

export interface AttemptInput {
  attemptId: string;
  cwd: string | null;
  model: string;
  effort: Effort;
  prompt: string;
  permissionProfile: PermissionProfile;
  // Native session to resume on the same provider only. Never another provider's id.
  resumeProviderSessionId: string | null;
}

export type AttemptTermination = 'completed' | 'failed' | 'interrupted';

export interface AttemptOutcome {
  termination: AttemptTermination;
  failure: Failure | null;
  // True only when every process the attempt started has provably exited.
  quiescent: boolean;
  providerSessionId: string | null;
}

export interface AttemptHandle {
  events: AsyncIterable<AdapterEventEnvelope>;
  interrupt(reason: string): Promise<void>;
  answerApproval(providerRequestId: string, decision: 'approve' | 'reject'): Promise<void>;
  // Resolves after the event stream is drained and process-group exit is observed.
  done: Promise<AttemptOutcome>;
  // Process-group id of the provider process, recorded so a restarted runner can stop it.
  pgid?: number;
}

export interface ProbeResult {
  installed: boolean;
  executablePath: string | null;
  version: string | null;
  supportedVersion: boolean;
  notes: string[];
}

export class UnsupportedOperationError extends Error {
  constructor(operation: string, adapter: string) {
    super(`${adapter} does not support ${operation}`);
    this.name = 'UnsupportedOperationError';
  }
}

export interface ProviderAdapter {
  readonly connectionId: string;
  readonly provider: Provider;
  readonly kind: AdapterKind;
  readonly isMock: boolean;
  probe(): Promise<ProbeResult>;
  getConnectionStatus(): Promise<Connection>;
  listModels(): Promise<ModelCapability[]>;
  startAttempt(input: AttemptInput): AttemptHandle;
  dispose(): Promise<void>;
}

// Small helper: a push-based async iterable used by adapters to expose event streams.
export class EventChannel<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.queue.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.queue.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
