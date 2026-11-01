import { describe, expect, it } from 'vitest';
import { Checkpoint, FailureKind, FallbackConfig, ProviderErrorCategory } from '@wots/protocol';
import { categoryOf } from '@wots/core';
import { laneFor } from '../../packages/design-tokens/src/index.ts';
import { ClaudeCodeAdapter } from '@wots/adapter-claude-code';
import { CodexAdapter } from '@wots/adapter-codex';
import { MockAdapter } from '@wots/adapter-mock';
import { loadFallback } from '../../apps/runner/src/runner.ts';

describe('provider foundation', () => {
  it('maps every FailureKind to a spec category', () => {
    for (const kind of FailureKind.options) {
      expect(ProviderErrorCategory.options).toContain(categoryOf(kind));
    }
    expect(categoryOf('timeout')).toBe('TIMEOUT');
    expect(categoryOf('transport')).toBe('NETWORK_ERROR');
    expect(categoryOf('transient_throttle')).toBe('RATE_LIMIT');
    expect(categoryOf('usage_limit')).toBe('QUOTA_EXCEEDED');
    expect(categoryOf('usage_limit_suspected')).toBe('QUOTA_EXCEEDED');
    expect(categoryOf('auth')).toBe('AUTH_EXPIRED');
    expect(categoryOf('outage')).toBe('PROVIDER_UNAVAILABLE');
    expect(categoryOf('model_unavailable')).toBe('PROVIDER_UNAVAILABLE');
    expect(categoryOf('permission_denied')).toBe('PERMISSION_DENIED');
    expect(categoryOf('policy_refusal')).toBe('PERMISSION_DENIED');
    expect(categoryOf('context_too_large')).toBe('EXECUTION_ERROR');
    expect(categoryOf('unknown')).toBe('UNKNOWN');
  });

  const oldConfig = {
    routes: [
      { connectionId: 'codex', modelId: 'gpt-6-astra' },
      { connectionId: 'claude-code', modelId: 'claude-opus-5-5' },
    ],
    effort: 'medium',
    speed: 'standard',
    autoFallback: true,
    outageFallback: false,
    allowApiBilling: false,
    switchAtPercent: 90,
  };

  it('keeps a saved FallbackConfig and adds defaults', () => {
    const cfg = FallbackConfig.parse(oldConfig);
    expect(cfg.routes).toEqual(oldConfig.routes);
    expect(cfg.switchAtPercent).toBe(90);
    expect(cfg.disabledConnections).toEqual([]);
    expect(cfg.attemptTimeoutMs).toBe(3_600_000);
    expect(cfg.transportRetries).toBe(2);
    expect(cfg.notifyOnSwitch).toBe(true);
    expect(() => FallbackConfig.parse({ ...oldConfig, transportRetries: 6 })).toThrow();
  });

  it('loadFallback normalises a stored config without adding or reordering routes', () => {
    const stored = { ...oldConfig } as Record<string, unknown>;
    const cfg = loadFallback({ getSetting: (_k: string, d: unknown) => stored ?? d } as never);
    expect(cfg.routes).toEqual(oldConfig.routes);
    expect(cfg.notifyOnSwitch).toBe(true);
    const none = loadFallback({ getSetting: (_k: string, d: unknown) => d } as never);
    expect(none.routes.map((r) => r.connectionId)).toEqual(['claude-code', 'codex']);
  });

  it('parses a checkpoint saved before the new fields', () => {
    const old = {
      id: 'chk_1', sessionId: 'ses_1', runId: 'run_1', objective: 'o', latestUserConstraints: [], completedSteps: [], pendingSteps: [], decisionNotes: [],
      recentMessages: [], baselineCommit: null, fileManifest: [], changedFiles: [], diff: '', testEvidence: [], providerBindings: {}, unresolvedActions: [],
      permissionVersion: 1, switchReason: null, previousProvider: null, createdAtSeq: 1, contentHash: 'h', createdAt: new Date().toISOString(),
    };
    const cp = Checkpoint.parse(old);
    expect(cp.nextRoute).toBeNull();
    expect(cp.handoffCategory).toBeNull();
    expect(cp.gitStatus).toEqual([]);
    expect(cp.knownErrors).toEqual([]);
    expect(cp.permissionProfile).toBeNull();
  });

  it('maps new providers to their own lanes', () => {
    expect(laneFor('cursor')).toBe('laneC');
    expect(laneFor('gemini')).toBe('laneD');
    expect(laneFor('mock-cursor')).toBe('laneC');
    expect(laneFor('mock-gemini')).toBe('laneD');
    expect(laneFor('codex')).toBe('laneB');
    expect(laneFor('claude-code')).toBe('laneA');
  });

  it('reports adapter capabilities', () => {
    const claude = new ClaudeCodeAdapter({ executable: null } as never).capabilities();
    expect(claude).toEqual({ streaming: true, nativeResume: true, approvals: 'none', edits: 'apply', usage: 'percent', models: 'fixed' });
    const codex = new CodexAdapter({ executable: null, chatSandboxDir: '/tmp' } as never).capabilities();
    expect(codex).toEqual({ streaming: true, nativeResume: true, approvals: 'bridged', edits: 'apply', usage: 'percent', models: 'listed' });
    const mock = new MockAdapter({ connectionId: 'mock-claude', label: 'm', models: ['x'], script: {} as never }).capabilities();
    expect(mock).toEqual({ streaming: true, nativeResume: true, approvals: 'bridged', edits: 'apply', usage: 'percent', models: 'fixed' });
  });
});
