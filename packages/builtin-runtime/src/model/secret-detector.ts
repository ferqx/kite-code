import { Buffer } from 'node:buffer';

export type ModelSecretInspection = Readonly<{
  schemaVersion: 1;
  detector: 'runtime_secret_detector';
  verdict: 'clear' | 'secret' | 'unknown';
}>;

const CREDENTIAL_ENV_NAME =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|client[_-]?secret|credential|password|secret)/i;
const SECRET_SHAPE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)[ \t]*[:=][ \t]*\S+/i,
  /\bbearer\s+[a-z0-9._~+/=-]+/i,
  /\b(?:sk|ghp|github_pat)[-_][a-z0-9_=-]{16,}\b/i,
  /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.ssh|\.aws|\.kube|credentials?|secrets?)(?:$|[/\\])/i,
] as const;

export function createModelSecretDetector(
  options: {
    readonly knownSecrets?: Iterable<string | undefined>;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly maxInspectionChars?: number;
  } = {},
): (input: Readonly<{ text: string; provenance?: string }>) => ModelSecretInspection {
  const knownSecrets = new Set<string>();
  for (const value of options.knownSecrets ?? []) if (value) knownSecrets.add(value);
  for (const [name, value] of Object.entries(options.environment ?? process.env)) {
    if (value && CREDENTIAL_ENV_NAME.test(name)) knownSecrets.add(value);
  }
  const maxInspectionChars = options.maxInspectionChars ?? 1_000_000;
  return ({ text }) => {
    if (text.length > maxInspectionChars) return inspection('unknown');
    for (const secret of knownSecrets) if (text.includes(secret)) return inspection('secret');
    return inspection(
      SECRET_SHAPE_PATTERNS.some((pattern) => pattern.test(text)) ||
        hasBasicAuthorizationCredential(text)
        ? 'secret'
        : 'clear',
    );
  };
}

function hasBasicAuthorizationCredential(text: string): boolean {
  const matches = text.matchAll(/\bbasic\s+([A-Za-z0-9+/]+={0,2})\b/gi);
  for (const match of matches) {
    const encoded = match[1]!;
    if (encoded.length % 4 === 1) continue;
    try {
      if (Buffer.from(encoded, 'base64').toString('utf8').includes(':')) return true;
    } catch {
      // An invalid candidate cannot be a Basic credential.
    }
  }
  return false;
}

function inspection(verdict: ModelSecretInspection['verdict']): ModelSecretInspection {
  return { schemaVersion: 1, detector: 'runtime_secret_detector', verdict };
}
