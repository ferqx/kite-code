import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  retainWindowsNativeRuntimeFiles,
  verifyNativeRuntimeBundle,
} from '@kite-ai/service/native-runtime-assets';
import {
  retainWindowsTerminalRuntimeFiles,
  windowsTerminalRuntimeArguments,
} from '@kite-ai/service/runtime-assets';
import {
  createWindowsNativeMainHandoff,
  retainWindowsNativeLaunchCertificate,
} from '@kite-ai/service/windows-native-bootstrap';
import { readManagedCLIActive } from '../../../apps/cli/host/cli-registration';
import {
  readWindowsNativeInstallation,
  retainWindowsNativeFrontdoor,
} from '../../../apps/cli/host/windows-native-installation';
import { acquireArtifactAccess } from '../../../packages/agent/src/artifact-access';
import { acquireFileLock } from '../../../packages/agent/src/platform/locks';
import { windowsInstallationCoordination } from '../../../packages/agent/src/platform/windows-installation-coordination';

type Resource = { release(): void | Promise<void> };
const retained = new Set<Resource[]>();
const environmentKeys = [
  'NODE_PATH',
  'NODE_OPTIONS',
  'BUN_OPTIONS',
  'BUN_BE_BUN',
  'ELECTRON_RUN_AS_NODE',
];
const uncertainCodes = new Set([
  'windows_path_security_denied',
  'windows_path_security_close_failed',
  'windows_artifact_files_close_unknown',
  'windows_lock_close_unknown',
  'Lock release failed.',
  'native_runtime_files_close_unknown',
  'native_runtime_verification_close_unknown',
  'artifact_access_acquire_close_unknown',
  'artifact_scope_release_failed',
  'windows_installation_coordination_close_failed',
  'windows_native_parent_close_unknown',
  'windows_native_handoff_close_unknown',
  'native_windows_frontdoor_close_unknown',
]);
function uncertain(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    uncertainCodes.has(error.message) ||
    uncertainCodes.has(String(Reflect.get(error, 'code'))) ||
    (error instanceof AggregateError && error.errors.some(uncertain)) ||
    (!!error.cause && uncertain(error.cause))
  );
}
async function keep(error: unknown, resources: Resource[]): Promise<never> {
  retained.add(resources);
  process.stderr.write('native_windows_bootstrap_close_unknown\n');
  return new Promise<never>(() => {
    setInterval(() => {
      void error;
      void resources;
    }, 60000);
  });
}
/** Only the fixed native first stage can certify this compiled verifier's original process. */
export async function runWindowsNativeVerifier(
  kind: string,
  prefix: string,
  launcherPipe: string,
  argv: readonly string[],
  expectedCandidateId?: string,
): Promise<number> {
  if (
    process.platform !== 'win32' ||
    process.arch !== 'x64' ||
    !['cli', 'tui', 'desktop'].includes(kind) ||
    realpathSync(process.execPath) !== join(prefix, 'bin', 'native-verifier.exe') ||
    argv.some(
      (arg) => arg.startsWith('--kite-native-handoff') || arg.startsWith('--kite-native-candidate'),
    ) ||
    (expectedCandidateId !== undefined && !/^[0-9a-f]{64}$/.test(expectedCandidateId)) ||
    (kind === 'desktop' && argv.length !== 0)
  )
    throw Error('native_windows_frontdoor_invalid');
  for (const key of environmentKeys)
    if (process.env[key] !== undefined) throw Error('native_windows_frontdoor_environment');
  const resources: Resource[] = [];
  retained.add(resources);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let result = 1,
    failure: unknown;
  const ignoreInterrupt = () => {};
  try {
    const coordination = windowsInstallationCoordination(prefix);
    resources.push(coordination);
    const selection = acquireFileLock(coordination.selectionLockPath, 'shared');
    resources.push(selection);
    coordination.verify();
    const frontdoor = retainWindowsNativeFrontdoor(readWindowsNativeInstallation(prefix));
    resources.push(frontdoor);
    const certificate = await retainWindowsNativeLaunchCertificate(
      prefix,
      kind as 'cli' | 'tui' | 'desktop',
      launcherPipe,
    );
    resources.push(certificate);
    const id = readManagedCLIActive(prefix);
    if (expectedCandidateId !== undefined && id !== expectedCandidateId)
      throw Error('cli_registration_changed');
    const root = join(prefix, 'releases', id),
      terminalRoot = join(root, 'terminal');
    // Put use rights before every consumer: reverse cleanup closes all files,
    // bootstrap/certificate owners and processes before either use lock.
    for (const selected of [root, terminalRoot])
      resources.unshift(acquireArtifactAccess({ root: selected, mode: 'shared' }));
    const outerFiles = retainWindowsNativeRuntimeFiles(root);
    resources.push(outerFiles);
    const innerFiles = retainWindowsTerminalRuntimeFiles(terminalRoot);
    resources.push(innerFiles);
    const bundle = verifyNativeRuntimeBundle(root);
    if (bundle.digest !== id || readManagedCLIActive(prefix) !== id)
      throw Error('native_windows_selection_changed');
    frontdoor.verify();
    certificate.verify();
    outerFiles.verify();
    innerFiles.verify();
    // Selection may change while the exact original candidate continues under its own use locks.
    selection.release();
    coordination.release();
    const env = { ...process.env };
    for (const key of environmentKeys) delete env[key];
    const handoff = kind === 'desktop' ? createWindowsNativeMainHandoff() : undefined;
    if (handoff) resources.push({ release: () => handoff.close() });
    process.on('SIGINT', ignoreInterrupt);
    child = Bun.spawn(
      kind === 'desktop'
        ? [
            join(root, bundle.manifest.entries.electron),
            join(root, 'app'),
            `--kite-native-handoff=${JSON.stringify({ launcherPipe, mainPipe: handoff!.pipe })}`,
          ]
        : [
            join(terminalRoot, bundle.terminal.manifest.entries.runtime),
            ...windowsTerminalRuntimeArguments(terminalRoot),
            join(terminalRoot, `entrypoints/native-${kind}.js`),
            ...argv,
          ],
      { cwd: process.cwd(), env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
    );
    handoff?.bind(child.pid);
    result = await child.exited;
  } catch (error) {
    failure = error;
  }
  // Neither failed launch admission nor failed wait is evidence that a child has exited.
  if (child && child.exitCode === null) {
    try {
      await child.exited;
    } catch (error) {
      return keep(new AggregateError([failure, error]), resources);
    }
  }
  process.removeListener('SIGINT', ignoreInterrupt);
  if (failure && uncertain(failure)) return keep(failure, resources);
  try {
    while (resources.length) {
      await resources.at(-1)!.release();
      resources.pop();
    }
    retained.delete(resources);
  } catch (error) {
    return keep(new AggregateError([failure, error]), resources);
  }
  if (failure) throw failure;
  return result;
}
export function parseWindowsNativeSelection(argv: readonly string[]): {
  argv: readonly string[];
  expectedCandidateId?: string;
} {
  const first = argv[0];
  if (first?.startsWith('--kite-native-candidate=')) {
    const expectedCandidateId = first.slice('--kite-native-candidate='.length);
    if (
      !/^[0-9a-f]{64}$/.test(expectedCandidateId) ||
      argv.slice(1).some((arg) => arg.startsWith('--kite-native-candidate'))
    )
      throw Error('native_windows_frontdoor_invalid');
    return { argv: argv.slice(1), expectedCandidateId };
  }
  if (argv.some((arg) => arg.startsWith('--kite-native-candidate')))
    throw Error('native_windows_frontdoor_invalid');
  return { argv };
}
if (import.meta.main) {
  try {
    const selection = parseWindowsNativeSelection(process.argv.slice(5));
    process.exitCode = await runWindowsNativeVerifier(
      process.argv[2] ?? '',
      process.argv[3] ?? '',
      process.argv[4] ?? '',
      selection.argv,
      selection.expectedCandidateId,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'native_windows_frontdoor_denied');
    process.exitCode = 1;
  }
}
