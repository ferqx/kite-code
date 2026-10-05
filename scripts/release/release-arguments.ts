/** Closed local tooling vocabulary; parsing cannot inspect profiles or release assets. */
export function parseReleaseArguments(
  argv: readonly string[],
  commands: Readonly<Record<string, readonly string[]>>,
): { readonly command: string; readonly values: Readonly<Record<string, string>> } {
  if (
    (argv.length === 1 && ['--help', '-h'].includes(argv[0]!)) ||
    (argv.length === 2 && Object.hasOwn(commands, argv[0]!) && ['--help', '-h'].includes(argv[1]!))
  )
    return { command: 'help', values: Object.freeze({}) };
  const command = argv[0];
  if (!command || !Object.hasOwn(commands, command)) throw Error('release_arguments_invalid');
  const allowed = commands[command]!;
  const values: Record<string, string> = Object.create(null);
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]!,
      key = flag.slice(2),
      value = argv[index + 1];
    if (
      !flag.startsWith('--') ||
      !allowed.includes(key) ||
      Object.hasOwn(values, key) ||
      !value ||
      value.startsWith('--') ||
      value.includes('\0') ||
      value.length > 4096
    )
      throw Error('release_arguments_invalid');
    values[key] = value;
  }
  return { command, values: Object.freeze(values) };
}

export function requiredReleaseValue(
  values: Readonly<Record<string, string>>,
  key: string,
): string {
  const value = values[key];
  if (!value) throw Error('release_arguments_invalid');
  return value;
}

export function validateReleaseSourceArguments(values: Readonly<Record<string, string>>): void {
  if (
    (values['clean-source'] !== undefined && values['clean-source'] !== 'true') ||
    (values['source-commit'] !== undefined && !/^[a-f0-9]{40}$/.test(values['source-commit']))
  )
    throw Error('release_arguments_invalid');
}

export function assertReleaseSource(
  source: { readonly commit: string; readonly dirty: boolean },
  values: Readonly<Record<string, string>>,
): void {
  if (
    (values['clean-source'] === 'true' && source.dirty) ||
    (values['source-commit'] !== undefined && values['source-commit'] !== source.commit)
  )
    throw Error('release_source_mismatch');
}

export function releaseErrorCode(error: unknown): string {
  const value =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : error instanceof Error
        ? error.message
        : '';
  return /^[a-z][a-z0-9_]{0,100}$/.test(value) ? value : 'release_failed';
}
