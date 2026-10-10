import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  readCLIRegistration,
  readManagedCLIActive,
  sameCLIRegistration,
} from '../../../apps/cli/host/cli-registration';
import {
  readWindowsNativeInstallation,
  retainWindowsNativeFrontdoor,
} from '../../../apps/cli/host/windows-native-installation';
import {
  readWindowsTerminalInstallation,
  retainWindowsTerminalFrontdoor,
} from '../../../apps/cli/host/windows-terminal-installation';
import {
  retainWindowsNativeRuntimeFiles,
  verifyNativeRuntimeBundle,
} from '../../../apps/service/src/native-runtime-assets';
import {
  retainWindowsTerminalRuntimeFiles,
  verifyTerminalRuntimeBundle,
  windowsTerminalRuntimeArguments,
} from '../../../apps/service/src/runtime-assets';
import { acquireArtifactAccess } from '../../../packages/agent/src/artifact-access';
import { acquireFileLock } from '../../../packages/agent/src/platform/locks';
import { windowsInstallationCoordination } from '../../../packages/agent/src/platform/windows-installation-coordination';

type Resource = { release(): void };
type FileResource = Resource & { verify(): void };
const retained = new Set<object>();
const environmentKeys = [
  'NODE_PATH',
  'NODE_OPTIONS',
  'BUN_OPTIONS',
  'BUN_BE_BUN',
  'ELECTRON_RUN_AS_NODE',
];
const unknownCodes = new Set([
  'windows_path_security_denied',
  'windows_path_security_close_failed',
  'native_runtime_files_close_unknown',
  'native_runtime_verification_close_unknown',
  'artifact_access_acquire_close_unknown',
  'artifact_scope_release_failed',
  'windows_installation_coordination_close_failed',
  'native_windows_frontdoor_close_unknown',
  'windows_artifact_files_close_unknown',
  'windows_lock_close_unknown',
  'Lock release failed.',
]);
function uncertain(error: unknown): boolean {
  return (
    error instanceof Error &&
    (unknownCodes.has(error.message) ||
      unknownCodes.has(String(Reflect.get(error, 'code'))) ||
      (error instanceof AggregateError && error.errors.some(uncertain)) ||
      (!!error.cause && uncertain(error.cause)))
  );
}
function keep(error: unknown, owner: object): Promise<never> {
  retained.add(owner);
  process.stderr.write('terminal_windows_bootstrap_close_unknown\n');
  return new Promise<never>(() => {
    setInterval(() => {
      void error;
      void owner;
    }, 60000);
  });
}
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
    realpathSync(process.execPath) !== join(prefix, 'bin', 'terminal-verifier.exe') ||
    argv.some(
      (arg) => arg.startsWith('--kite-native-candidate') || arg.startsWith('--kite-native-handoff'),
    )
  )
    throw Error('terminal_windows_frontdoor_invalid');
  for (const key of environmentKeys)
    if (process.env[key] !== undefined) throw Error('terminal_windows_frontdoor_environment');
  const files: FileResource[] = [],
    uses: Resource[] = [],
    selections: Resource[] = [];
  let child: ReturnType<typeof Bun.spawn> | undefined,
    result = 1,
    failure: unknown;
  const owner = {
    files,
    uses,
    selections,
    get child() {
      return child;
    },
  };
  retained.add(owner);
  const ignoreInterrupt = () => {};
  const select = (selectedPrefix: string) => {
    const coordination = windowsInstallationCoordination(selectedPrefix);
    let selection: ReturnType<typeof acquireFileLock> | undefined;
    const resource = {
      release() {
        coordination.release();
        selection?.release();
      },
    };
    selections.push(resource);
    selection = acquireFileLock(coordination.selectionLockPath, 'shared');
    coordination.verify();
    return resource;
  };
  try {
    const initial = select(prefix);
    const marker = readWindowsTerminalInstallation(prefix);
    const frontdoor = retainWindowsTerminalFrontdoor(marker);
    files.push(frontdoor);
    const id = readManagedCLIActive(prefix),
      root = join(prefix, 'releases', id);
    uses.push(acquireArtifactAccess({ root, mode: 'shared' }));
    const terminalFiles = retainWindowsTerminalRuntimeFiles(root);
    files.push(terminalFiles);
    const bundle = verifyTerminalRuntimeBundle(root);
    if (bundle.digest !== id || readManagedCLIActive(prefix) !== id)
      throw Error('terminal_windows_selection_changed');
    const registration = readCLIRegistration(prefix);
    let command: string[];
    if (registration) {
      // The first read is only a selector. Reacquire both selection regions in the installer's fixed order.
      initial.release();
      selections.pop();
      for (const selected of [prefix, registration.nativePrefix].sort()) select(selected);
      if (
        !sameCLIRegistration(registration, readCLIRegistration(prefix)) ||
        !sameCLIRegistration(registration, readCLIRegistration(registration.nativePrefix, true))
      )
        throw Error('cli_registration_owner_mismatch');
      if (
        readManagedCLIActive(prefix) !== id ||
        readManagedCLIActive(registration.nativePrefix) !== registration.candidateId
      )
        throw Error('cli_registration_changed');
      const nativeMarker = readWindowsNativeInstallation(registration.nativePrefix);
      const nativeFrontdoor = retainWindowsNativeFrontdoor(nativeMarker);
      files.push(nativeFrontdoor);
      const nativeRoot = join(registration.nativePrefix, 'releases', registration.candidateId),
        innerRoot = join(nativeRoot, 'terminal');
      for (const selected of [nativeRoot, innerRoot])
        uses.push(acquireArtifactAccess({ root: selected, mode: 'shared' }));
      const outerFiles = retainWindowsNativeRuntimeFiles(nativeRoot);
      files.push(outerFiles);
      const innerFiles = retainWindowsTerminalRuntimeFiles(innerRoot);
      files.push(innerFiles);
      const nativeBundle = verifyNativeRuntimeBundle(nativeRoot);
      if (
        nativeBundle.digest !== registration.candidateId ||
        !sameCLIRegistration(registration, readCLIRegistration(prefix)) ||
        !sameCLIRegistration(registration, readCLIRegistration(registration.nativePrefix, true)) ||
        readManagedCLIActive(prefix) !== id ||
        readManagedCLIActive(registration.nativePrefix) !== registration.candidateId
      )
        throw Error('cli_registration_changed');
      // The stable C frontdoor certifies the real creator. Its verifier admits exactly this selection or rejects CAS drift.
      command = [
        join(registration.nativePrefix, 'bin', kind === 'cli' ? 'kite.exe' : 'kite-tui.exe'),
        `--kite-native-candidate=${registration.candidateId}`,
        ...argv,
      ];
    } else {
      if (readCLIRegistration(prefix) !== undefined)
        throw Error('terminal_windows_selection_changed');
      command = [
        join(root, bundle.manifest.entries.runtime),
        ...windowsTerminalRuntimeArguments(root),
        join(root, `entrypoints/standard-${kind}.js`),
        ...argv,
      ];
    }
    for (const file of files) file.verify();
    while (selections.length) {
      selections.at(-1)!.release();
      selections.pop();
    }
    const env = { ...process.env };
    for (const key of environmentKeys) delete env[key];
    process.on('SIGINT', ignoreInterrupt);
    child = Bun.spawn(command, {
      cwd: process.cwd(),
      env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    result = await child.exited;
  } catch (error) {
    failure = error;
  }
  // A rejected wait never proves the original child stopped consuming its pinned files.
  if (child && child.exitCode === null) {
    try {
      await child.exited;
    } catch (error) {
      return keep(new AggregateError([failure, error]), owner);
    }
  }
  process.removeListener('SIGINT', ignoreInterrupt);
  if (failure && uncertain(failure)) return keep(failure, owner);
  try {
    // All file objects close before any use region, including either stable frontdoor.
    for (const group of [files, uses, selections])
      while (group.length) {
        group.at(-1)!.release();
        group.pop();
      }
    retained.delete(owner);
  } catch (error) {
    return keep(new AggregateError([failure, error]), owner);
  }
  if (failure) throw failure;
  return result;
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
