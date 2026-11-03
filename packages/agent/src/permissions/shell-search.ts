import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ripgrepAsset } from '../jobs/ripgrep';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** A single literal query only. No wrappers, redirects, expansion, hooks or ambient rg config. */
export function readOnlySearchCommand(
  commands: readonly (readonly string[])[] | null,
  shellExecutable: string,
  coreutilsPath?: string,
) {
  if (commands?.length !== 1) return;
  const [name, ...args] = commands[0]!;
  const rg = ripgrepAsset();
  if (name === 'rg' || name === 'rg.exe' || name === rg) {
    if (
      args
        .slice(0, args.includes('--') ? args.indexOf('--') : args.length)
        .some(
          (arg) =>
            arg.startsWith('--') &&
            arg !== '--' &&
            ['--pre', '--hostname-bin'].some(
              (hook) => hook.startsWith(arg.split('=', 1)[0]!) || arg.startsWith(hook),
            ),
        )
    )
      return;
    return [quote(rg.replaceAll('\\', '/')), '--no-config', ...args.map(quote)].join(' ');
  }
  if (name === 'pwd' && args.length === 0) return 'pwd';
  if (name === 'ls') {
    if (process.platform === 'win32' && !/(?:isksh|bash|sh)\.exe$/i.test(shellExecutable)) return;
    const executable =
      process.platform === 'win32'
        ? realpathSync.native(coreutilsPath ?? join(dirname(shellExecutable), 'coreutils.exe'))
        : realpathSync.native('/bin/ls');
    return [
      quote(executable.replaceAll('\\', '/')),
      ...(process.platform === 'win32' ? ['ls'] : []),
      ...args.map(quote),
    ].join(' ');
  }
  return undefined;
}
