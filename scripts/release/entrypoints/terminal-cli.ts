import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { runCLIProcess } from '@kite-ai/cli/main';
import { verifyTerminalBundle } from '../../../apps/cli/host/terminal-artifact';
import { parseCLIArguments } from '../../../apps/cli/src/arguments';

/** import.meta.dir belongs to this candidate, never the installer's mutable active pointer. */
const bundleRoot = resolve(import.meta.dir, '..');
export async function runInstalledTerminalCLI(
  argv: readonly string[] = process.argv.slice(2),
  candidateRoot: string = bundleRoot,
) {
  const args = parseCLIArguments(argv);
  const pure = ['help', 'version', 'trace'].includes(args.kind);
  const root = pure ? undefined : realpathSync(candidateRoot);
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
if (import.meta.main) {
  try {
    process.exitCode = await runInstalledTerminalCLI();
  } catch (error) {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[a-z][a-z0-9_]{0,80}$/.test(error.code)
        ? error.code
        : 'terminal_cli_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
