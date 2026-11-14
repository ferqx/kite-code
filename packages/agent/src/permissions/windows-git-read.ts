// Literal built-in Git queries only. Positional revisions use a deliberately
// small grammar, so a token cannot be reinterpreted as an executable option.
const revision = /^[\w./@{}^~:+-]+$/u;
const statusOptions = new Set([
  '-s',
  '-sb',
  '-bs',
  '--short',
  '-b',
  '--branch',
  '--porcelain',
  '--porcelain=v1',
  '--porcelain=v2',
  '-uno',
  '-unormal',
  '-uall',
  '--untracked-files=no',
  '--untracked-files=normal',
  '--untracked-files=all',
  '--no-ahead-behind',
  '-z',
]);
const diffOptions = new Set([
  '--stat',
  '--shortstat',
  '--numstat',
  '--name-only',
  '--name-status',
  '--summary',
  '--cached',
  '--staged',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '-p',
  '--patch',
  '--check',
  '-z',
]);
const logOptions = new Set([
  '--oneline',
  '--graph',
  '--decorate',
  '--no-decorate',
  '--all',
  '--stat',
  '--name-only',
  '--name-status',
  '--no-color',
  '--no-show-signature',
  '--no-ext-diff',
  '--no-textconv',
]);
const lsFilesOptions = new Set(['-z', '--cached', '--others', '--exclude-standard', '--stage']);
const revParseOptions = new Set([
  '--show-toplevel',
  '--show-prefix',
  '--is-inside-work-tree',
  '--short',
  '--verify',
  '--abbrev-ref',
  '--git-dir',
]);

export function windowsGitQuery(args: readonly string[]): string[] | undefined {
  const offset = args[0] === '--no-pager' ? 1 : 0;
  const verb = args[offset];
  const rest = args.slice(offset + 1);
  if (rest.some((arg) => arg.includes('"'))) return;
  const revisions = (value: string) => !value.startsWith('-') && revision.test(value);
  const paths = (options: ReadonlySet<string>, positionals: (value: string) => boolean) => {
    const delimiter = rest.indexOf('--');
    const before = delimiter < 0 ? rest : rest.slice(0, delimiter);
    return before.every((arg) => options.has(arg) || positionals(arg));
  };
  let flags: string[] = [];
  switch (verb) {
    case 'status':
      if (!paths(statusOptions, () => false)) return;
      break;
    case 'diff':
      if (!paths(diffOptions, revisions)) return;
      flags = ['--no-ext-diff', '--no-textconv'];
      break;
    case 'log':
    case 'show':
      if (!paths(logOptions, (arg) => revisions(arg) || /^-\d+$|^--max-count=\d+$/u.test(arg)))
        return;
      flags = ['--no-ext-diff', '--no-textconv', '--no-show-signature'];
      break;
    case 'branch':
      // The default listing is read-only only with zero arguments or --list.
      if (
        rest.length &&
        !(rest.length === 1 && rest[0] === '--show-current') &&
        !(rest[0] === '--list' && rest.slice(1).every(revisions))
      )
        return;
      break;
    case 'rev-parse':
      if (!rest.length || !rest.every((arg) => revParseOptions.has(arg) || revisions(arg))) return;
      break;
    case 'ls-files':
      if (!paths(lsFilesOptions, () => false)) return;
      break;
    default:
      return;
  }
  return [
    '--no-pager',
    '--no-optional-locks',
    '--no-lazy-fetch',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'submodule.recurse=false',
    '-c',
    'maintenance.auto=false',
    '-c',
    'log.showSignature=false',
    verb,
    ...flags,
    ...rest,
  ];
}
