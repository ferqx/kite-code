import type { SessionLoggingContentInspectionV1, SessionLoggingContentInspectorV1 } from './types';

const MAX_INSPECTION_CHARS = 1_000_000;
const CREDENTIAL_ENV_NAME =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|client[_-]?secret|credential|password|secret)/i;
const SECRET_SHAPE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*[:=]\s*\S+/i,
  /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/i,
  /\b(?:sk|ghp|github_pat)[-_][a-z0-9_=-]{16,}\b/i,
  /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.ssh|\.aws|\.kube|credentials?|secrets?)(?:$|[/\\])/i,
] as const;

export interface RuntimeSecretDetectorOptionsV1 {
  knownSecrets?: Iterable<string | undefined>;
  environment?: Readonly<Record<string, string | undefined>>;
  maxInspectionChars?: number;
}

function inspection(
  verdict: SessionLoggingContentInspectionV1['verdict'],
): SessionLoggingContentInspectionV1 {
  return {
    schemaVersion: 1,
    detector: 'runtime_secret_detector',
    verdict,
  };
}

/**
 * Build the content-logging admission detector from Runtime-held credential
 * material plus conservative secret shapes. Exact known-secret matching is
 * the primary signal; regex-based shapes only raise the result to secret.
 */
export function createRuntimeSecretDetectorV1(
  options: RuntimeSecretDetectorOptionsV1 = {},
): SessionLoggingContentInspectorV1 {
  const knownSecrets = new Set<string>();
  for (const value of options.knownSecrets ?? []) {
    if (value) knownSecrets.add(value);
  }
  for (const [name, value] of Object.entries(options.environment ?? process.env)) {
    if (value && CREDENTIAL_ENV_NAME.test(name)) knownSecrets.add(value);
  }
  const maxInspectionChars = options.maxInspectionChars ?? MAX_INSPECTION_CHARS;

  return ({ text }) => {
    if (text.length > maxInspectionChars) return inspection('unknown');
    for (const secret of knownSecrets) {
      if (text.includes(secret)) return inspection('secret');
    }
    if (SECRET_SHAPE_PATTERNS.some((pattern) => pattern.test(text))) {
      return inspection('secret');
    }
    return inspection('clear');
  };
}
