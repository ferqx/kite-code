export type ModelSecretInspectionV1 = Readonly<{
  schemaVersion: 1;
  detector: 'runtime_secret_detector';
  verdict: 'clear' | 'secret' | 'unknown';
}>;

const CREDENTIAL_ENV_NAME =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|client[_-]?secret|credential|password|secret)/i;
const SECRET_SHAPE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*[:=]\s*\S+/i,
  /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/i,
  /\b(?:sk|ghp|github_pat)[-_][a-z0-9_=-]{16,}\b/i,
  /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.ssh|\.aws|\.kube|credentials?|secrets?)(?:$|[/\\])/i,
] as const;

export function createModelSecretDetectorV1(
  options: {
    readonly knownSecrets?: Iterable<string | undefined>;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly maxInspectionChars?: number;
  } = {},
): (input: Readonly<{ text: string; provenance?: string }>) => ModelSecretInspectionV1 {
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
      SECRET_SHAPE_PATTERNS.some((pattern) => pattern.test(text)) ? 'secret' : 'clear',
    );
  };
}

function inspection(verdict: ModelSecretInspectionV1['verdict']): ModelSecretInspectionV1 {
  return { schemaVersion: 1, detector: 'runtime_secret_detector', verdict };
}
