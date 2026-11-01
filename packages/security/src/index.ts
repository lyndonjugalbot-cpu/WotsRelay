import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

// Stable hash of a JSON-compatible value (keys sorted) so argument digests are reproducible.
export function canonicalHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

// ---- Secret redaction ------------------------------------------------------------------------

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, '[REDACTED:anthropic-key]'],
  [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED:openai-key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED:github-token]'],
  [/\bwotsd_[A-Za-z0-9_-]{20,}/g, '[REDACTED:device-token]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED:jwt]'],
  [/(\b(?:api[_-]?key|secret|token|password|passwd|authorization)\b\s*[:=]\s*)(["']?)[^\s"']{8,}\2/gi, '$1[REDACTED]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g, '$1[REDACTED]'],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

export function containsSecret(text: string): boolean {
  return redact(text) !== text;
}

// Paths never sent across providers or into exports unless the user overrides exclusions.
export const DEFAULT_SECRET_PATH_PATTERNS = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_ed25519*',
  '.npmrc',
  '.netrc',
  '.aws/**',
  '.ssh/**',
  '**/credentials*',
  '**/secrets*',
];

export const DEFAULT_IGNORED_DIRS = ['.git', 'node_modules', '.wots-dev', 'dist', 'build', '.next', '.venv', '__pycache__'];

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(relPath: string, patterns: readonly string[]): boolean {
  const base = relPath.split('/').pop() ?? relPath;
  return patterns.some((p) => {
    const re = globToRegExp(p);
    return re.test(relPath) || (!p.includes('/') && re.test(base));
  });
}

// Names of environment variables that would silently change a provider's billing route.
export const BILLING_ENV_VARS = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'],
  openai: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'],
} as const;

// Report presence only. Values are never read into logs.
export function detectBillingEnv(env: NodeJS.ProcessEnv, provider: keyof typeof BILLING_ENV_VARS): string[] {
  return BILLING_ENV_VARS[provider].filter((k) => typeof env[k] === 'string' && env[k] !== '');
}

// ---- Pairing (spec §7: single-use, 2 minute expiry, rate limited) ---------------------------

export const PAIRING_TTL_MS = 2 * 60 * 1000;

export function newPairingCode(): { code: string; hash: string } {
  const code = randomBytes(16).toString('base64url');
  return { code, hash: sha256(code) };
}

export const DEVICE_TOKEN_PREFIX = 'wotsd_';

// Bearer secret for one paired device. Only its sha256 is stored.
export function newDeviceToken(): { token: string; hash: string } {
  const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: sha256(token) };
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
