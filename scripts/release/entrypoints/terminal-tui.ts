import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { parseTUIArguments, runTUIProcess } from '@kite-ai/cli/tui-main';
import { verifyTerminalBundle } from '../../../apps/cli/host/terminal-artifact';

const bundleRoot = resolve(import.meta.dir, '..');
export async function runInstalledTerminalTUI(
  argv: readonly string[] = process.argv.slice(2),
  candidateRoot: string = bundleRoot,
) {
  const args = parseTUIArguments(argv);
  // Preserve pure help/version and the original nonterminal rejection without touching a profile.
  const root =
    args.kind === 'tui' && process.stdin.isTTY && process.stdout.isTTY
      ? realpathSync(candidateRoot)
      : undefined;
  const access = root ? acquireArtifactAccess({ root, mode: 'shared' }) : undefined;
  try {
    const bundle = root ? verifyTerminalBundle(root) : undefined;
    return await runTUIProcess({
      argv,
      ...(bundle ? { artifact: bundle.artifact } : {}),
      dataRoot: join(homedir(), '.kite-code', 'unified-agent'),
      profile: 'default',
    });
  } finally {
    access?.release();
  }
}
if (import.meta.main) {
  try {
    process.exitCode = await runInstalledTerminalTUI();
  } catch (error) {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[a-z][a-z0-9_]{0,80}$/.test(error.code)
        ? error.code
        : 'terminal_tui_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
