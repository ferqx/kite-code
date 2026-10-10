import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readManagedCLIActive } from '../../../apps/cli/host/cli-registration';
import {
  readWindowsTerminalInstallation,
  retainWindowsTerminalFrontdoor,
} from '../../../apps/cli/host/windows-terminal-installation';
import {
  retainWindowsTerminalRuntimeFiles,
  verifyTerminalRuntimeBundle,
  windowsTerminalRuntimeArguments,
} from '../../../apps/service/src/runtime-assets';
import { acquireArtifactAccess } from '../../../packages/agent/src/artifact-access';
import { acquireFileLock } from '../../../packages/agent/src/platform/locks';
import { windowsInstallationCoordination } from '../../../packages/agent/src/platform/windows-installation-coordination';

/** Standalone trusted second stage. Native first stage sanitizes before Bun initializes. */
export async function runWindowsTerminalVerifier(
  kind: string,
  prefix: string,
  argv: readonly string[],
): Promise<number> {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('terminal_windows_frontdoor_unsupported');
  if (
    !['cli', 'tui'].includes(kind) ||
    realpathSync(process.execPath) !== join(prefix, 'bin', 'terminal-verifier.exe')
  )
    throw Error('terminal_windows_frontdoor_invalid');
  // Neither user environment nor current working directory can supply an entrypoint.
  for (const key of [
    'NODE_PATH',
    'NODE_OPTIONS',
    'BUN_OPTIONS',
    'BUN_BE_BUN',
    'ELECTRON_RUN_AS_NODE',
  ])
    if (process.env[key] !== undefined) throw Error('terminal_windows_frontdoor_environment');
  const coordination = windowsInstallationCoordination(prefix);
  let selection: ReturnType<typeof acquireFileLock> | undefined;
  let candidate: ReturnType<typeof acquireArtifactAccess> | undefined;
  let files: ReturnType<typeof retainWindowsTerminalRuntimeFiles> | undefined;
  let frontdoor: ReturnType<typeof retainWindowsTerminalFrontdoor> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const ignoreInterrupt = () => {};
  try {
    selection = acquireFileLock(coordination.selectionLockPath, 'shared');
    coordination.verify();
    const marker = readWindowsTerminalInstallation(prefix);
    frontdoor = retainWindowsTerminalFrontdoor(marker);
    // Native's independent loading handoff is still unqualified on Windows.
    if (existsSync(join(prefix, '.kite-cli-registration.json')))
      throw Error('native_windows_bootstrap_unqualified');
    const id = readManagedCLIActive(prefix);
    const root = join(prefix, 'releases', id);
    candidate = acquireArtifactAccess({ root, mode: 'shared' });
    files = retainWindowsTerminalRuntimeFiles(root);
    const bundle = verifyTerminalRuntimeBundle(root);
    if (
      bundle.digest !== id ||
      readManagedCLIActive(prefix) !== id ||
      existsSync(join(prefix, '.kite-cli-registration.json'))
    )
      throw Error('terminal_windows_selection_changed');
    frontdoor.verify();
    files.verify();
    selection.release();
    selection = undefined;
    coordination.release();
    const env = { ...process.env };
    for (const key of [
      'NODE_PATH',
      'NODE_OPTIONS',
      'BUN_OPTIONS',
      'BUN_BE_BUN',
      'ELECTRON_RUN_AS_NODE',
    ])
      delete env[key];
    process.on('SIGINT', ignoreInterrupt);
    child = Bun.spawn(
      [
        join(root, bundle.manifest.entries.runtime),
        ...windowsTerminalRuntimeArguments(root),
        join(root, `entrypoints/standard-${kind}.js`),
        ...argv,
      ],
      { cwd: process.cwd(), env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
    );
    return await child.exited;
  } finally {
    // The exact consumer must exit before any candidate or bootstrap pin is released.
    if (child && child.exitCode === null) await child.exited;
    process.removeListener('SIGINT', ignoreInterrupt);
    files?.release();
    candidate?.release();
    frontdoor?.release();
    selection?.release();
    coordination.release();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await runWindowsTerminalVerifier(
      process.argv[2] ?? '',
      process.argv[3] ?? '',
      process.argv.slice(4),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'terminal_windows_frontdoor_denied');
    process.exitCode = 1;
  }
}
