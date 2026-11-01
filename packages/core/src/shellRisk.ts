import type { RiskCategory } from '@wots/protocol';

// Shell commands from either provider, classified by what they can touch. Compound commands
// (`a && b | c`) take the riskiest part; anything not recognised stays 'unknown'.
const READ_ONLY = /^(ls|pwd|cat|head|tail|less|wc|rg|grep|egrep|find|fd|tree|stat|file|du|df|which|whereis|type|echo|printf|date|whoami|uname|env|printenv|sort|uniq|cut|tr|diff|cmp|od|hexdump|shasum|sha256sum|md5|jq|true|test|\[|git (status|diff|log|show|branch|rev-parse|ls-files|blame|remote -v|describe|tag --list))(\s|$)/;
// Script runners (`npm run x`, `make`, `node file`) can do anything, so they stay 'unknown'.
const LOCAL_WRITE = /^(mkdir|touch|cp|mv|ln|chmod|tee|sed -i|perl -pi|git (add|commit|checkout|switch|restore|stash|mv)|npm test|pnpm test|yarn test|npx (tsc|vitest|jest|eslint|prettier)|tsc|vitest|jest|pytest|python3? -m (pytest|unittest)|cargo (build|test|check|fmt)|go (build|test|vet|fmt))(\s|$)/;
// Network, remote state, package installs (they download and run install scripts), deletion, system.
const EXTERNAL = /^(curl|wget|ssh|scp|sftp|rsync|nc|telnet|ftp|git (push|pull|fetch|clone|reset --hard|clean)|npm (publish|install|i|ci)|yarn (add|install|publish)|pnpm (add|install|i|publish)|pip3? install|brew|docker|kubectl|terraform|gh|aws|gcloud|az|sudo|rm|rmdir|dd|mkfs|kill|pkill|killall|shutdown|reboot|launchctl|osascript|open)(\s|$)/;

const ORDER: RiskCategory[] = ['read-only', 'reversible-local-write', 'unknown', 'external-side-effect'];

// Codex reports commands wrapped as `/bin/zsh -lc "…"`; judge what actually runs.
export function unwrapShell(command: string): string {
  const m = command.trim().match(/^(?:\/bin\/|\/usr\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/);
  return m ? m[2]!.replace(/\\(["'\\])/g, '$1') : command.trim();
}

export function classifyShellCommand(command: string): RiskCategory {
  const parts = unwrapShell(command)
    .split(/\s*(?:&&|\|\||;|\||\n)\s*/)
    .map((p) => p.trim().replace(/^(?:\w+=\S*\s+)+/, '')) // leading VAR=value assignments
    .filter(Boolean);
  if (!parts.length) return 'unknown';
  let worst: RiskCategory = 'read-only';
  for (const p of parts) {
    let r: RiskCategory = EXTERNAL.test(p) ? 'external-side-effect' : LOCAL_WRITE.test(p) ? 'reversible-local-write' : READ_ONLY.test(p) ? 'read-only' : 'unknown';
    // Output redirection or command substitution turns a read into a write (or worse).
    if (r === 'read-only' && /(^|[^<>&\d])>{1,2}\s*(?!&)/.test(p)) r = 'reversible-local-write';
    if (r === 'read-only' && /`|\$\(/.test(p)) r = 'unknown';
    if (ORDER.indexOf(r) > ORDER.indexOf(worst)) worst = r;
  }
  return worst;
}

export function describeRisk(risk: RiskCategory): string {
  switch (risk) {
    case 'read-only':
      return 'only reads';
    case 'reversible-local-write':
      return 'changes files in this folder';
    case 'external-side-effect':
      return 'reaches outside this folder (network, deletion or system change)';
    default:
      return 'not recognised; review it';
  }
}
