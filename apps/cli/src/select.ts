import { emitKeypressEvents } from 'node:readline';
import { bold, cyan, dim } from './ui.ts';

export interface Choice<T> {
  label: string;
  hint?: string;
  value: T;
}

export type PickerKey = { name?: string; sequence?: string; ctrl?: boolean };
export type PickerStep = { index: number; result?: 'select' | 'cancel' };

// Pure key handling so the picker can be tested without a terminal.
export function pickerStep(index: number, count: number, key: PickerKey): PickerStep {
  if (key.ctrl && key.name === 'c') return { index, result: 'cancel' };
  switch (key.name) {
    case 'up':
    case 'k':
      return { index: (index - 1 + count) % count };
    case 'down':
    case 'j':
    case 'tab':
      return { index: (index + 1) % count };
    case 'return':
    case 'enter':
      return { index, result: 'select' };
    case 'escape':
    case 'q':
      return { index, result: 'cancel' };
  }
  const n = Number.parseInt(key.sequence ?? '', 10);
  if (n >= 1 && n <= Math.min(count, 9)) return { index: n - 1, result: 'select' };
  return { index };
}

// Arrow-key list on stderr. Resolves null on Esc / Ctrl-C, or when stdin is not a terminal.
export function select<T>(title: string, choices: Choice<T>[], initial = 0): Promise<T | null> {
  const input = process.stdin;
  const out = process.stderr;
  if (!input.isTTY || !choices.length) return Promise.resolve(null);
  let index = Math.max(0, Math.min(initial, choices.length - 1));
  let drawn = 0;
  const render = () => {
    if (drawn) out.write(`\x1b[${drawn}A\x1b[0J`);
    const lines = [bold(title), ...choices.map((c, i) => `${i === index ? cyan('❯') : ' '} ${i < 9 ? dim(`${i + 1}.`) : '  '} ${i === index ? cyan(c.label) : c.label}${c.hint ? `  ${dim(c.hint)}` : ''}`), dim('  ↑/↓ to move · Enter to choose · Esc to cancel')];
    const text = lines.join('\n');
    out.write(`${text}\n`);
    // Titles may span lines and long rows wrap; count terminal rows so the redraw lands exactly.
    drawn = text.split('\n').reduce((n, l) => n + 1 + Math.floor(Math.max(0, visibleLength(l) - 1) / Math.max(20, out.columns ?? 80)), 0);
  };
  return new Promise((resolve) => {
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    const onKey = (_: string, key: PickerKey) => {
      const step = pickerStep(index, choices.length, key ?? {});
      index = step.index;
      if (!step.result) return render();
      input.off('keypress', onKey);
      input.setRawMode(false);
      input.pause();
      // Collapse the list to a single line naming what was chosen.
      out.write(`\x1b[${drawn}A\x1b[0J`);
      if (step.result === 'select') out.write(`${dim(title.split('\n')[0]!)} ${choices[index]!.label}\n`);
      resolve(step.result === 'select' ? choices[index]!.value : null);
    };
    input.on('keypress', onKey);
    render();
  });
}

function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}
