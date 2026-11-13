import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { runCLIProcess } from '@kite-ai/cli/main';
import {
  resolveTerminalBundleRoot,
  verifyTerminalBundle,
} from '../../../apps/cli/host/terminal-artifact';
import { parseCLIArguments } from '../../../apps/cli/src/arguments';
import { releaseErrorCode } from '../release-arguments';

/** The module belongs to the candidate, independent of the current selection. */
const bundleRoot = resolve(import.meta.dirname, '..');
export async function runInstalledTerminalCLI(
  argv: readonly string[] = process.argv.slice(2),
  candidateRoot: string = bundleRoot,
) {
  const args = parseCLIArguments(argv);
  const pure = ['help', 'version', 'trace'].includes(args.kind);
  const root = pure ? undefined : resolveTerminalBundleRoot(candidateRoot);
  const access = root ? acquireArtifactAccess({ root, mode: 'shared' }) : undefined;
  try {
    const bundle = root ? verifyTerminalBundle(root) : undefined;
    return await runCLIProcess({
      argv,
      ...(bundle ? { artifact: bundle.artifact, resolveArtifact: () => bundle.artifact } : {}),
      dataRoot: join(homedir(), '.kite-code', 'unified-agent'),
      profile: 'default',
    });
  } finally {
    access?.release();
  }
}
if (Reflect.get(import.meta, 'main') === true) {
  try {
    process.exitCode = await runInstalledTerminalCLI();
  } catch (error) {
    const code = releaseErrorCode(error, 'terminal_cli_failed');
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
