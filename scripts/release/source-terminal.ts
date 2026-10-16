import { resolve } from 'node:path';
import { runInstalledTerminalCLI } from './entrypoints/terminal-cli';
import { releaseErrorCode, sourceCandidateBuildHint } from './release-arguments';

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
  /** Trusted fixture option; ordinary argv cannot enable test diagnostics. */
  options: { readonly testDiagnostics?: boolean } = {},
): Promise<number> {
  const { runInstalledTerminalTUI } = await import('./entrypoints/terminal-tui');
  return runInstalledTerminalTUI(argv, sourceTerminalRoot(root), options);
}
export async function terminalEntrypoint(run: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await run();
  } catch (error) {
    const code = releaseErrorCode(error, 'terminal_host_failed');
    process.stderr.write(`${code}\n${sourceCandidateBuildHint(code)}`);
    process.exitCode = 1;
  }
}
if (import.meta.main) await terminalEntrypoint(() => runSourceTerminalCLI());
