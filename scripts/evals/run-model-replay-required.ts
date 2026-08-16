import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROBE_PORT_ENV = 'KITE_MODEL_REPLAY_LOOPBACK_PROBE_PORT_V1';
const EXPECTED_UID_ENV = 'KITE_MODEL_REPLAY_EXPECTED_UID_V1';
const root = process.cwd();

export function buildRequiredReplayIsolationCommandV1(input: {
  platform: 'darwin' | 'linux';
  environment: Readonly<Record<string, string>>;
  runtimePath: string;
  isolatedRunnerPath: string;
  uid: number;
  gid: number;
}): string[] {
  const child = [
    '/usr/bin/env',
    '-i',
    ...Object.entries(input.environment).map(([key, value]) => `${key}=${value}`),
    input.runtimePath,
    '--no-env-file',
    input.isolatedRunnerPath,
  ];
  if (input.platform === 'darwin') {
    return ['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network*)', ...child];
  }
  return [
    '/usr/bin/sudo',
    '-n',
    '/usr/bin/unshare',
    '--net',
    '--',
    '/usr/bin/setpriv',
    `--reuid=${input.uid}`,
    `--regid=${input.gid}`,
    '--clear-groups',
    '--no-new-privs',
    '--bounding-set=-all',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    ...child,
  ];
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

function createPrivateRuntimeDirectory(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'kite-model-replay-required-'));
  chmodSync(directory, 0o700);
  return directory;
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

function failureReason(exitCode: number): string {
  if (exitCode === 81) return 'model_replay_required_gate_failed';
  if (exitCode === 82) return 'model_replay_required_tests_failed';
  return 'model_replay_required_network_isolation_failed';
}

async function main(): Promise<void> {
  let reason = 'model_replay_required_network_isolation_failed';
  let runtimeDirectory: string | undefined;
  let listener: Awaited<ReturnType<typeof listenForIsolationProbe>> | undefined;
  try {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new Error('unsupported isolation platform');
    }
    if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
      throw new Error('missing process identity');
    }
    runtimeDirectory = createPrivateRuntimeDirectory();
    listener = await listenForIsolationProbe();
    const environment = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: runtimeDirectory,
      TMPDIR: runtimeDirectory,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      NO_COLOR: '1',
      [PROBE_PORT_ENV]: String(listener.port),
      [EXPECTED_UID_ENV]: String(process.getuid()),
    };
    const command = buildRequiredReplayIsolationCommandV1({
      platform: process.platform,
      environment,
      runtimePath: process.execPath,
      isolatedRunnerPath: fileURLToPath(
        new URL('./run-model-replay-required-isolated.ts', import.meta.url),
      ),
      uid: process.getuid(),
      gid: process.getgid(),
    });
    const child = Bun.spawn(command, {
      cwd: root,
      env: { PATH: environment.PATH },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const exitCode = await child.exited;
    const executionFailureReason = failureReason(exitCode);
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
