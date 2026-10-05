import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLIHostError, type CLIServiceArtifact, parseCLIServiceArtifact } from './index';
import { parseTUIArguments } from './tui-arguments';

export { parseTUIArguments } from './tui-arguments';
export async function runTUIProcess(
  input: {
    argv?: readonly string[];
    artifact?: CLIServiceArtifact;
    dataRoot?: string;
    profile?: string;
    cwd?: string;
    onLaunched?: (value: { pid: number }) => void;
  } = {},
): Promise<number> {
  const args = parseTUIArguments(input.argv ?? process.argv.slice(2));
  if (args.kind === 'help') {
    process.stdout.write(
      'Development TUI [--workspace <path>] [--thread <id>] [--data-root <absolute>] [--server <local socket>]\nCtrl+R Session selection; Ctrl+N new; Ctrl+Q quit; Ctrl+C exact work cancellation.\n',
    );
    return 0;
  }
  if (args.kind === 'version') {
    process.stdout.write('kite development TUI 0.1.0\n');
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new CLIHostError('tui_terminal_unavailable');
  let artifact = input.artifact;
  if (!artifact && !args.server) {
    try {
      artifact = parseCLIServiceArtifact(
        JSON.parse(readFileSync(join(import.meta.dir, 'cli-assets.json'), 'utf8')),
      );
    } catch {
      throw new CLIHostError('cli_artifact_unavailable');
    }
  }
  const exit = new AbortController();
  const stop = () => exit.abort();
  process.on('SIGTERM', stop);
  try {
    const { runTUIHost } = await import('./tui');
    return await runTUIHost({
      artifact,
      dataRoot:
        args.dataRoot ??
        input.dataRoot ??
        join(input.cwd ?? process.cwd(), '.kite-code', 'unified-development'),
      ...(input.profile ? { profile: input.profile } : {}),
      ...(args.workspace ? { workspace: args.workspace } : {}),
      ...(args.thread ? { thread: args.thread } : {}),
      ...(args.server ? { server: args.server } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.onLaunched ? { onLaunched: input.onLaunched } : {}),
      exitSignal: exit.signal,
    });
  } finally {
    process.removeListener('SIGTERM', stop);
  }
}
if (import.meta.main) {
  try {
    process.exitCode = await runTUIProcess();
  } catch (error) {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[a-z][a-z0-9_]{0,80}$/.test(error.code)
        ? error.code
        : 'tui_host_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
