import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { parseTUIArguments, runTUIProcess } from '@kite-ai/cli/tui-main';
import {
  resolveTerminalBundleRoot,
  verifyTerminalBundle,
} from '../../../apps/cli/host/terminal-artifact';
import { releaseErrorCode } from '../release-arguments';

const bundleRoot = resolve(import.meta.dir, '..');
export async function runInstalledTerminalTUI(
  argv: readonly string[] = process.argv.slice(2),
  candidateRoot: string = bundleRoot,
  options: { readonly testDiagnostics?: boolean } = {},
) {
  const args = parseTUIArguments(argv);
  // Preserve pure help/version and the original nonterminal rejection without touching a profile.
  const root =
    args.kind === 'tui' && process.stdin.isTTY && process.stdout.isTTY
      ? resolveTerminalBundleRoot(candidateRoot)
      : undefined;
  const access = root ? acquireArtifactAccess({ root, mode: 'shared' }) : undefined;
  try {
    const bundle = root ? verifyTerminalBundle(root) : undefined;
    return await runTUIProcess({
      argv,
      ...(bundle ? { artifact: bundle.artifact } : {}),
      dataRoot: join(homedir(), '.kite-code', 'unified-agent'),
      profile: 'default',
      testDiagnostics: options.testDiagnostics,
    });
  } finally {
    access?.release();
  }
}
if (import.meta.main) {
  try {
    process.exitCode = await runInstalledTerminalTUI();
  } catch (error) {
    const code = releaseErrorCode(error, 'terminal_tui_failed');
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
