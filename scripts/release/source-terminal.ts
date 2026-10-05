import { resolve } from 'node:path';
import { runInstalledTerminalCLI } from './entrypoints/terminal-cli';

const repositoryRoot = resolve(import.meta.dir, '../..');
/** Trusted checkout selection, never an argv override or a development fallback. */
export function sourceTerminalRoot(root = repositoryRoot): string {
  return resolve(root, 'dist/unified-terminal');
}
export function runSourceTerminalCLI(
  argv: readonly string[] = process.argv.slice(2),
  root = repositoryRoot,
): Promise<number> {
  return runInstalledTerminalCLI(argv, sourceTerminalRoot(root));
}
export async function runSourceTerminalTUI(
  argv: readonly string[] = process.argv.slice(2),
  root = repositoryRoot,
): Promise<number> {
  const { runInstalledTerminalTUI } = await import('./entrypoints/terminal-tui');
  return runInstalledTerminalTUI(argv, sourceTerminalRoot(root));
}
export async function terminalEntrypoint(run: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await run();
  } catch (error) {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[a-z][a-z0-9_]{0,80}$/.test(error.code)
        ? error.code
        : 'terminal_host_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
if (import.meta.main) await terminalEntrypoint(() => runSourceTerminalCLI());
