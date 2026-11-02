import type { Checkpoint } from '@wots/protocol';
import { redact } from '@wots/security';

// Conservative estimate; real tokenizers differ per provider, so leave headroom.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export interface HandoffBudget {
  contextLimit: number | null;
  reserveForOutput: number;
  fallbackCap: number;
}

export const DEFAULT_BUDGET: HandoffBudget = { contextLimit: null, reserveForOutput: 16_000, fallbackCap: 48_000 };

export interface HandoffResult {
  prompt: string;
  tokens: number;
  omitted: string[];
  // Set when an indispensable section could not fit: the caller must pause instead.
  blockedBy: string | null;
}

interface Section {
  key: string;
  critical: boolean;
  text: string;
  // Optional degraded form tried before omitting a non-critical section.
  shrink?: () => string;
}

// Spec §10 priority order. Deterministic: same checkpoint and budget => byte-identical prompt.
export function buildHandoff(cp: Checkpoint, budget: HandoffBudget = DEFAULT_BUDGET, nextInstruction?: string): HandoffResult {
  const limit = Math.max(2_000, (budget.contextLimit ?? budget.fallbackCap) - budget.reserveForOutput);
  const sections: Section[] = [];

  sections.push({
    key: 'header',
    critical: true,
    text: [
      '# WotsRelay handoff',
      'You are continuing a task that another agent session started. This is a portable, evidence-based handoff, not the previous agent’s memory.',
      cp.previousProvider ? `Previous route: ${cp.previousProvider.connectionId} (${cp.previousProvider.model}). Switch reason: ${cp.switchReason ?? 'n/a'}.` : '',
      'Before acting, verify the workspace state yourself (read the files listed below). The filesystem is authoritative; this summary is an aid.',
    ]
      .filter(Boolean)
      .join('\n'),
  });
  sections.push({ key: 'objective', critical: true, text: `## Original objective\n${cp.objective}` });
  if (cp.latestUserConstraints.length) {
    sections.push({ key: 'constraints', critical: true, text: `## Latest user instructions and corrections (highest priority)\n${cp.latestUserConstraints.map((c) => `- ${c}`).join('\n')}` });
  }
  sections.push({
    key: 'safety',
    critical: true,
    text: `## Safety and permission constraints\n- Permission version: ${cp.permissionVersion}. Earlier approvals do not carry over to new or changed actions.\n- Do not work around any denied action or policy boundary.\n- Do not repeat completed steps listed below.`,
  });
  if (cp.unresolvedActions.length) {
    sections.push({
      key: 'unresolved',
      critical: true,
      text: `## Unresolved operations — DO NOT REPEAT without user confirmation\n${cp.unresolvedActions.map((a) => `- [${a.status}] ${a.name}: ${a.argsPreview} (risk: ${a.risk})`).join('\n')}`,
    });
  }
  sections.push({
    key: 'progress',
    critical: true,
    text: `## Progress\nCompleted (backed by the action log):\n${listOrNone(cp.completedSteps)}\nRemaining:\n${listOrNone(cp.pendingSteps)}`,
  });
  sections.push({
    key: 'do-not-repeat',
    critical: true,
    text: `## Do not repeat\nThese steps already ran in this session. Verify their result; do not run them again.\n${listOrNone(cp.completedSteps)}`,
  });
  if (cp.changedFiles.length) {
    sections.push({
      key: 'changed-files',
      critical: true,
      text: `## Files changed so far in this run (verify; do not redo)\n${cp.changedFiles.map((f) => `- ${f.change}: ${f.path}${f.sha256 ? ` (sha256 ${f.sha256.slice(0, 16)})` : ''}`).join('\n')}${cp.baselineCommit ? `\nBaseline commit: ${cp.baselineCommit}` : ''}`,
    });
  }
  if (cp.gitStatus.length) sections.push({ key: 'git-status', critical: false, text: `## Git status (paths only)\n${cp.gitStatus.map((l) => `- ${l}`).join('\n')}` });
  if (cp.knownErrors.length) sections.push({ key: 'known-errors', critical: false, text: `## Known errors\n${cp.knownErrors.map((l) => `- ${l}`).join('\n')}` });
  if (cp.diff) {
    const full = `## Diff\n\`\`\`diff\n${cp.diff}\n\`\`\``;
    sections.push({ key: 'diff', critical: false, text: full, shrink: () => `## Diff\n(Diff omitted for size; inspect the changed files listed above.)` });
  }
  if (cp.testEvidence.length) sections.push({ key: 'tests', critical: false, text: `## Test evidence\n${cp.testEvidence.map((t) => `- ${t}`).join('\n')}` });
  if (cp.decisionNotes.length) sections.push({ key: 'decisions', critical: false, text: `## Decision notes\n${cp.decisionNotes.map((t) => `- ${t}`).join('\n')}` });
  if (cp.recentMessages.length) {
    const render = (msgs: Checkpoint['recentMessages']) =>
      `## Recent conversation\n${msgs
        .map((m) => `### ${m.role === 'user' ? 'User' : `Assistant (${m.provider ?? '?'} / ${m.model ?? '?'})`}${m.interrupted ? ' — INTERRUPTED, incomplete' : ''}\n${m.text}`)
        .join('\n\n')}`;
    sections.push({ key: 'recent-messages', critical: false, text: render(cp.recentMessages), shrink: () => render(cp.recentMessages.slice(-2)) });
  }
  sections.push({
    key: 'next',
    critical: true,
    text: `## Your next step\n${nextInstruction ?? 'Verify the workspace, then continue with the first remaining item. Report clearly when the objective is complete.'}`,
  });

  const omitted: string[] = [];
  const kept = sections.map((s) => ({ ...s, text: redact(s.text) }));
  const total = () => estimateTokens(kept.map((s) => s.text).join('\n\n'));

  // Degrade lowest-priority non-critical sections first (reverse order).
  for (let i = kept.length - 1; i >= 0 && total() > limit; i--) {
    const s = kept[i]!;
    if (s.critical) continue;
    if (s.shrink) {
      s.text = redact(s.shrink());
      if (total() <= limit) {
        omitted.push(`${s.key} (shortened)`);
        break;
      }
    }
    s.text = '';
    omitted.push(s.key);
  }

  const prompt = kept.map((s) => s.text).filter(Boolean).join('\n\n') + (omitted.length ? `\n\n(Omitted for context budget: ${omitted.join(', ')})` : '');
  const tokens = estimateTokens(prompt);
  return { prompt, tokens, omitted, blockedBy: tokens > limit ? 'critical sections exceed the receiving route’s context budget' : null };
}

function listOrNone(items: string[]): string {
  return items.length ? items.map((s) => `- ${s}`).join('\n') : '- (none recorded)';
}
