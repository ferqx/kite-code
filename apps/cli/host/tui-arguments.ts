export type TUIArguments =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'tui'; workspace?: string; thread?: string; dataRoot?: string; server?: string };
export class TUIArgumentError extends Error {
  readonly code = 'invalid_tui_arguments';
  constructor() {
    super('invalid_tui_arguments');
  }
}
/** Pure vocabulary, before asset/profile/terminal discovery. */
export function parseTUIArguments(argv: readonly string[]): TUIArguments {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === 'help')) return { kind: 'help' };
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === 'version'))
    return { kind: 'version' };
  const result: Extract<TUIArguments, { kind: 'tui' }> = { kind: 'tui' };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (
      !key ||
      !['--workspace', '--thread', '--data-root', '--server'].includes(key) ||
      seen.has(key)
    )
      throw new TUIArgumentError();
    seen.add(key);
    const value = argv[++index];
    if (!value || value.startsWith('--') || value.includes('\0')) throw new TUIArgumentError();
    if (key === '--data-root') {
      if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)) throw new TUIArgumentError();
      result.dataRoot = value;
    } else if (key === '--server') {
      if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)) throw new TUIArgumentError();
      result.server = value;
    } else if (key === '--workspace') result.workspace = value;
    else result.thread = value;
  }
  return Object.freeze(result);
}
