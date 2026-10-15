/** A presentation classification of exact parsed argv. It grants no execution or filesystem scope. */
export function shellExplorationPresentation(
  commands: readonly (readonly string[])[] | null,
): 'exploration' | 'standalone' {
  if (!commands?.length) return 'standalone';
  const reads = new Set([
    'pwd',
    'ls',
    'cat',
    'head',
    'tail',
    'wc',
    'grep',
    'rg',
    'echo',
    'printf',
    'sleep',
  ]);
  const eligible = commands.every(([name, ...args]) => {
    if (name === 'git')
      return (
        ['status', 'log', 'diff', 'show', 'ls-files', 'ls-tree', 'rev-parse'].includes(
          args[0] ?? '',
        ) &&
        !args.some(
          (arg) =>
            ['--ext-diff', '--textconv', '-c', '--exec-path'].includes(arg) ||
            arg.startsWith('--output') ||
            arg.startsWith('--config'),
        )
      );
    if (!name || !reads.has(name)) return false;
    return !args.some(
      (arg) =>
        arg === '--pre' || arg.startsWith('--pre=') || arg === '--files-without-match-and-write',
    );
  });
  return eligible ? 'exploration' : 'standalone';
}
