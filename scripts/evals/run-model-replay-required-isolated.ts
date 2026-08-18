import { readFileSync, readlinkSync } from 'node:fs';
import { createConnection } from 'node:net';

const PROBE_PORT_ENV = 'KITE_MODEL_REPLAY_LOOPBACK_PROBE_PORT_V1';
const EXPECTED_UID_ENV = 'KITE_MODEL_REPLAY_EXPECTED_UID_V1';
const root = process.cwd();

function isolatedEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

async function assertKnownLoopbackListenerDenied(): Promise<void> {
  const port = Number(process.env[PROBE_PORT_ENV]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('loopback probe identity invalid');
  }
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1_000);
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('loopback listener remained reachable'));
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', () => resolve());
  });
}

function statusField(status: string, name: string): string {
  const match = status.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'mu'));
  if (!match) throw new Error('linux isolation status missing');
  return match[1]!.trim();
}

function assertLinuxPrivilegeDrop(): void {
  const expectedUid = process.env[EXPECTED_UID_ENV];
  if (!expectedUid || !/^\d+$/u.test(expectedUid)) throw new Error('expected uid missing');
  const status = readFileSync('/proc/self/status', 'utf8');
  const uids = statusField(status, 'Uid').split(/\s+/u);
  if (uids[0] !== expectedUid || uids[1] !== expectedUid) {
    throw new Error('linux uid isolation invalid');
  }
  if (statusField(status, 'Groups') !== '' || statusField(status, 'NoNewPrivs') !== '1') {
    throw new Error('linux privilege isolation invalid');
  }
  for (const field of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
    if (!/^0+$/u.test(statusField(status, field))) {
      throw new Error('linux capability isolation invalid');
    }
  }
  if (readlinkSync('/proc/self/ns/net') === readlinkSync('/proc/1/ns/net')) {
    throw new Error('linux network namespace isolation invalid');
  }
  const sudoProbe = Bun.spawnSync(['/usr/bin/sudo', '-n', '/usr/bin/id', '-u'], {
    cwd: root,
    env: isolatedEnvironment(),
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  if (sudoProbe.exitCode === 0) throw new Error('linux privilege regain remained available');
}

function runSync(command: readonly string[]): number {
  return Bun.spawnSync(command, {
    cwd: root,
    env: isolatedEnvironment(),
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  }).exitCode;
}

async function main(): Promise<number> {
  try {
    await assertKnownLoopbackListenerDenied();
    if (process.platform === 'linux') assertLinuxPrivilegeDrop();
  } catch {
    return 80;
  }
  const preload = '--preload=./scripts/evals/replay-network-deny.ts';
  const gate = runSync([
    process.execPath,
    '--no-env-file',
    preload,
    './scripts/evals/model-replay-gate.ts',
  ]);
  if (gate !== 0) return 81;
  const tests = runSync([
    process.execPath,
    '--no-env-file',
    preload,
    'test',
    'tests/evals/agent-tasks/replay-gate.test.ts',
    'tests/evals/agent-tasks/replay-subagent-journey.test.ts',
    'tests/model-response-source.test.ts',
    'tests/model-invocation-recovery.test.ts',
    'tests/execution/tool-pipeline-stages.test.ts',
    'tests/runtime/tool-outcome-recovery.test.ts',
  ]);
  return tests === 0 ? 0 : 82;
}

process.exitCode = await main();
