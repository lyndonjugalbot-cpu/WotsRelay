import { describe, expect, it } from 'vitest';
import { promoteRoute } from '@wots/core';
import { mockPair } from '@wots/adapter-mock';
import type { Session } from '@wots/protocol';
import { RunnerClient, startRunner } from '@wots/runner';
import { pickerStep } from '../../apps/cli/src/select.ts';
import { tempDir } from '../helpers.ts';

const claude = { connectionId: 'claude-code', modelId: 'claude-opus-5-5' };
const codex = { connectionId: 'codex', modelId: 'gpt-6-astra' };

describe('/model route promotion', () => {
  it('puts the chosen model first and keeps the other provider as fallback', () => {
    expect(promoteRoute([claude, codex], codex)).toEqual([codex, claude]);
    expect(promoteRoute([claude, codex], { connectionId: 'claude-code', modelId: 'claude-sonnet-5-5' })).toEqual([{ connectionId: 'claude-code', modelId: 'claude-sonnet-5-5' }, codex]);
    expect(promoteRoute([codex, claude], { connectionId: 'codex', modelId: 'gpt-6.1-sol' })).toEqual([{ connectionId: 'codex', modelId: 'gpt-6.1-sol' }, claude]);
  });
});

describe('picker keys', () => {
  it('moves with arrows and j/k, wraps, selects with Enter or a number, cancels with Esc/Ctrl-C', () => {
    expect(pickerStep(0, 3, { name: 'down' })).toEqual({ index: 1 });
    expect(pickerStep(0, 3, { name: 'up' })).toEqual({ index: 2 });
    expect(pickerStep(2, 3, { name: 'j' })).toEqual({ index: 0 });
    expect(pickerStep(1, 3, { name: 'return' })).toEqual({ index: 1, result: 'select' });
    expect(pickerStep(0, 3, { sequence: '3' })).toEqual({ index: 2, result: 'select' });
    expect(pickerStep(0, 3, { sequence: '4' })).toEqual({ index: 0 });
    expect(pickerStep(1, 3, { name: 'escape' })).toEqual({ index: 1, result: 'cancel' });
    expect(pickerStep(1, 3, { name: 'c', ctrl: true })).toEqual({ index: 1, result: 'cancel' });
  });
});

describe('sessions.setRoute', () => {
  it('reorders only that session and refuses a provider of the wrong kind', async () => {
    const runner = await startRunner({ home: tempDir('wsr-'), adapters: () => mockPair('success'), refreshOnStart: false });
    const cl = await new RunnerClient(runner.paths.socket).connect();
    try {
      const a = await cl.call<Session>('sessions.create', { projectId: null, mode: 'mock' });
      const b = await cl.call<Session>('sessions.create', { projectId: null, mode: 'mock' });
      const [first, second] = a.fallback.routes;
      const updated = await cl.call<Session>('sessions.setRoute', { sessionId: a.id, route: second });
      expect(updated.fallback.routes).toEqual([second, first]);
      expect((await cl.call<{ session: Session }>('sessions.get', { sessionId: b.id })).session.fallback.routes).toEqual([first, second]);
      await expect(cl.call('sessions.setRoute', { sessionId: a.id, route: claude })).rejects.toMatchObject({ code: 'invalid_params' });
    } finally {
      cl.close();
      await runner.stop();
    }
  });
});
