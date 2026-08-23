const CREDENTIAL_ENV_NAME =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|client[_-]?secret|credential|password|secret)/i;
const SECRET_SHAPE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*[:=]\s*\S+/i,
  /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/i,
  /\b(?:sk|ghp|github_pat)[-_][a-z0-9_=-]{16,}\b/i,
  /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.ssh|\.aws|\.kube|credentials?|secrets?)(?:$|[/\\])/i,
] as const;

export function inspectRuntimeSecret(input: {
  text: string;
  knownSecrets?: Iterable<string | undefined>;
  maxInspectionChars: number;
}): 'clear' | 'secret' | 'unknown' {
  if (input.text.length > input.maxInspectionChars) return 'unknown';
  const knownSecrets = new Set<string>();
  for (const value of input.knownSecrets ?? []) if (value) knownSecrets.add(value);
  for (const [name, value] of Object.entries(process.env)) {
    if (value && CREDENTIAL_ENV_NAME.test(name)) knownSecrets.add(value);
  }
  for (const secret of knownSecrets) if (input.text.includes(secret)) return 'secret';
  return SECRET_SHAPE_PATTERNS.some((pattern) => pattern.test(input.text)) ? 'secret' : 'clear';
}
