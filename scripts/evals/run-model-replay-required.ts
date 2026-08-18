import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROBE_PORT_ENV = 'KITE_MODEL_REPLAY_LOOPBACK_PROBE_PORT_V1';
const EXPECTED_UID_ENV = 'KITE_MODEL_REPLAY_EXPECTED_UID_V1';
const EXPECTED_OUTER_NETNS_ENV = 'KITE_MODEL_REPLAY_OUTER_NETNS_V1';
const root = realpathSync(process.cwd());

export function buildRequiredReplayIsolationCommandV1(input: {
  platform: 'darwin' | 'linux';
  environment: Readonly<Record<string, string>>;
  runtimePath: string;
  isolatedRunnerPath: string;
  workspacePath: string;
  uid: number;
  gid: number;
  linuxReadOnlyPaths?: readonly string[];
}): string[] {
  const child = (
    runtimePath: string,
    isolatedRunnerPath = input.isolatedRunnerPath,
    environment = input.environment,
  ) => [
    '/usr/bin/env',
    '-i',
    ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    runtimePath,
    '--no-env-file',
    isolatedRunnerPath,
  ];
  if (input.platform === 'darwin') {
    return [
      '/usr/bin/sandbox-exec',
      '-p',
      '(version 1)(allow default)(deny network*)',
      ...child(input.runtimePath),
    ];
  }
  const privateRuntimeDirectory = input.environment.HOME;
  if (!privateRuntimeDirectory) throw new Error('Linux replay isolation requires private HOME.');
  if (!input.linuxReadOnlyPaths || input.linuxReadOnlyPaths.length === 0) {
    throw new Error('Linux replay isolation requires read-only roots.');
  }
  const command = [
    '/usr/bin/sudo',
    '-n',
    '--',
    '/usr/bin/bwrap',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'CAP_SETUID',
    '--cap-add',
    'CAP_SETGID',
    '--cap-add',
    'CAP_SETPCAP',
  ];
  for (const path of input.linuxReadOnlyPaths) {
    command.push('--ro-bind', path, path);
  }
  const sandboxRuntimeDirectory = '/kite-model-replay-runtime-v1';
  const sandboxPrivateDirectory = '/kite-model-replay-private-v1';
  const sandboxWorkspaceDirectory = '/kite-model-replay-workspace-v1';
  const sandboxRuntimePath = join(sandboxRuntimeDirectory, basename(input.runtimePath));
  const runnerRelativePath = relative(input.workspacePath, input.isolatedRunnerPath);
  if (
    runnerRelativePath === '' ||
    runnerRelativePath === '..' ||
    runnerRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(runnerRelativePath)
  ) {
    throw new Error('Linux replay runner must be inside the workspace.');
  }
  const sandboxRunnerPath = join(sandboxWorkspaceDirectory, runnerRelativePath);
  const linuxEnvironment = {
    ...input.environment,
    HOME: sandboxPrivateDirectory,
    TMPDIR: sandboxPrivateDirectory,
    BUN_INSTALL_CACHE_DIR: sandboxPrivateDirectory,
    XDG_CACHE_HOME: sandboxPrivateDirectory,
  };
  command.push(
    '--ro-bind',
    dirname(input.runtimePath),
    sandboxRuntimeDirectory,
    '--ro-bind',
    input.workspacePath,
    sandboxWorkspaceDirectory,
    '--tmpfs',
    '/tmp',
    '--bind',
    privateRuntimeDirectory,
    sandboxPrivateDirectory,
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--unshare-pid',
    '--unshare-net',
    '--die-with-parent',
    '--new-session',
    '--chdir',
    sandboxWorkspaceDirectory,
    '--',
    '/usr/bin/setpriv',
    '--reuid',
    String(input.uid),
    '--regid',
    String(input.gid),
    '--clear-groups',
    '--no-new-privs',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    '--bounding-set=-all',
    ...child(sandboxRuntimePath, sandboxRunnerPath, linuxEnvironment),
  );
  return command;
}

async function listenForIsolationProbe(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('loopback listener invalid');
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: address.port });
      socket.setTimeout(1_000);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error('loopback listener unreachable'));
      });
      socket.once('error', reject);
    });
    return { port: address.port, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

function createPrivateRuntimeDirectory(runtimePath: string): {
  root: string;
  home: string;
  executable: string;
} {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'kite-model-replay-required-'));
  chmodSync(directory, 0o700);
  const home = join(directory, 'home');
  const executableDirectory = join(directory, 'bin');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(executableDirectory, { mode: 0o700 });
  const executable = join(executableDirectory, 'bun');
  copyFileSync(runtimePath, executable);
  chmodSync(executable, 0o555);
  return { root: directory, home, executable };
}

function removePrivateRuntimeDirectory(directory: string): void {
  const status = lstatSync(directory);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    realpathSync(directory) !== directory ||
    (typeof process.getuid === 'function' && status.uid !== process.getuid())
  ) {
    throw new Error('private runtime directory ownership invalid');
  }
  rmSync(directory, { recursive: true });
}

export function modelReplayIsolationFailureReasonV1(
  exitCode: number,
  isolatedStderr: string,
): string {
  if (exitCode === 80) return 'model_replay_required_network_isolation_assertion_failed';
  if (exitCode === 81) return 'model_replay_required_gate_failed';
  if (exitCode === 82) return 'model_replay_required_tests_failed';
  if (/sudo:/iu.test(isolatedStderr)) {
    return 'model_replay_required_privileged_launcher_failed';
  }
  if (
    /setpriv|setgroups|setuid|setgid|capabilit|no_new_privs|supplementary group/iu.test(
      isolatedStderr,
    )
  ) {
    return 'model_replay_required_privilege_drop_failed';
  }
  if (/operation not permitted|namespace|userns|unshare|clone_new/iu.test(isolatedStderr)) {
    return 'model_replay_required_namespace_unavailable';
  }
  if (/no such file|not found|execvp/iu.test(isolatedStderr)) {
    return 'model_replay_required_isolation_input_missing';
  }
  if (
    /bind|mount|mkdir|make \/ slave|make \/ private|pivot_root|chroot|remount/iu.test(
      isolatedStderr,
    )
  ) {
    return 'model_replay_required_isolation_mount_failed';
  }
  if (/bwrap:/iu.test(isolatedStderr)) {
    return 'model_replay_required_bubblewrap_setup_failed';
  }
  const accessDenied = /permission denied|access denied|eacces/iu.test(isolatedStderr);
  if (accessDenied && /kite-model-replay-runtime-v1/iu.test(isolatedStderr)) {
    return 'model_replay_required_bun_executable_access_denied';
  }
  if (accessDenied && /run-model-replay-required-isolated\.ts/iu.test(isolatedStderr)) {
    return 'model_replay_required_isolated_runner_access_denied';
  }
  if (accessDenied) {
    return 'model_replay_required_isolation_access_denied';
  }
  if (/shared librar|symbol lookup|dynamic linker|ld-linux|glibc/iu.test(isolatedStderr)) {
    return 'model_replay_required_isolated_runtime_dependency_failed';
  }
  if (/module|resolve|import|script/iu.test(isolatedStderr)) {
    return 'model_replay_required_isolated_runtime_source_failed';
  }
  if (/read-only file system|erofs/iu.test(isolatedStderr)) {
    return 'model_replay_required_isolated_runtime_read_only_violation';
  }
  if (/invalid argument|unknown option|unsupported/iu.test(isolatedStderr)) {
    return 'model_replay_required_isolation_configuration_invalid';
  }
  if (/killed|signal|segmentation|illegal instruction|abort/iu.test(isolatedStderr)) {
    return 'model_replay_required_isolation_process_crashed';
  }
  if (/failed|unable|cannot|can't/iu.test(isolatedStderr)) {
    return 'model_replay_required_isolation_operation_failed';
  }
  if (/bun:|^error:/imu.test(isolatedStderr)) {
    return 'model_replay_required_isolated_runtime_failed';
  }
  if (isolatedStderr.trim() === '') {
    return 'model_replay_required_isolation_process_failed_without_stderr';
  }
  return 'model_replay_required_isolation_process_failed_with_unclassified_stderr';
}

async function main(): Promise<void> {
  let reason = 'model_replay_required_network_isolation_failed';
  let runtimeDirectory: string | undefined;
  let isolatedRuntimePath = realpathSync(process.execPath);
  let privateHome = '';
  let listener: Awaited<ReturnType<typeof listenForIsolationProbe>> | undefined;
  try {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new Error('unsupported isolation platform');
    }
    if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
      throw new Error('missing process identity');
    }
    reason = 'model_replay_required_runtime_directory_setup_failed';
    const privateRuntime = createPrivateRuntimeDirectory(isolatedRuntimePath);
    runtimeDirectory = privateRuntime.root;
    privateHome = privateRuntime.home;
    isolatedRuntimePath = privateRuntime.executable;
    reason = 'model_replay_required_loopback_probe_setup_failed';
    listener = await listenForIsolationProbe();
    const environment = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: privateHome,
      TMPDIR: privateHome,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      NO_COLOR: '1',
      [PROBE_PORT_ENV]: String(listener.port),
      [EXPECTED_UID_ENV]: String(process.getuid()),
      ...(process.platform === 'linux'
        ? { [EXPECTED_OUTER_NETNS_ENV]: readlinkSync('/proc/self/ns/net') }
        : {}),
    };
    reason = 'model_replay_required_isolation_command_build_failed';
    const command = buildRequiredReplayIsolationCommandV1({
      platform: process.platform,
      environment,
      runtimePath: isolatedRuntimePath,
      isolatedRunnerPath: fileURLToPath(
        new URL('./run-model-replay-required-isolated.ts', import.meta.url),
      ),
      workspacePath: root,
      uid: process.getuid(),
      gid: process.getgid(),
      ...(process.platform === 'linux'
        ? {
            linuxReadOnlyPaths: [
              ...new Set(
                ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/sys'].filter(existsSync),
              ),
            ],
          }
        : {}),
    });
    reason = 'model_replay_required_isolation_process_spawn_failed';
    const child = Bun.spawn(command, {
      cwd: root,
      env: { PATH: environment.PATH },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    });
    reason = 'model_replay_required_isolation_process_observation_failed';
    const [exitCode, isolatedStderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    const executionFailureReason = modelReplayIsolationFailureReasonV1(
      exitCode,
      isolatedStderr.slice(0, 8_192),
    );
    reason = 'model_replay_required_cleanup_failed';
    await listener.close();
    listener = undefined;
    removePrivateRuntimeDirectory(runtimeDirectory);
    runtimeDirectory = undefined;
    if (exitCode !== 0) {
      reason = executionFailureReason;
      throw new Error(reason);
    }
    console.log(
      JSON.stringify({
        schema: 'ModelReplayRequiredGateReportV1',
        status: 'passed',
        case: 'model-replay-required-suite-v1@1',
        reason: 'approved_suite_passed_under_os_network_isolation',
        networkIsolation: process.platform === 'darwin' ? 'macos-seatbelt' : 'linux-netns',
        contentLogged: false,
      }),
    );
  } catch {
    if (listener) await listener.close().catch(() => undefined);
    if (runtimeDirectory) {
      try {
        removePrivateRuntimeDirectory(runtimeDirectory);
      } catch {
        reason = 'model_replay_required_cleanup_failed';
      }
    }
    console.error(
      JSON.stringify({
        schema: 'ModelReplayRequiredGateReportV1',
        status: 'failed',
        case: 'model-replay-required-suite-v1@1',
        reason,
        contentLogged: false,
      }),
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
